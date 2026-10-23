import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, transaction } from './db.js';
import { STEAM, DEFAULT_LOCALE, DATA_DIR } from './config.js';

// Tienda de Steam: storesearch (búsqueda por nombre, sin key), IStoreBrowseService/GetItems (datos y precios
// de muchos juegos por pedido, sin key) e IStoreService/GetAppList (lista completa, con STEAM_API_KEY).
// Límite aproximado: ~200 pedidos cada 5 minutos.
const STORE = 'https://store.steampowered.com/api';
const OVERRIDES_FILE = 'steam-overrides.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeout = 20_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const err = new Error(`Steam respondió ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Normalización de nombres ----------
// Xbox y Steam escriben distinto el mismo juego: "Edición Definitiva" vs "Definitive Edition",
// "(PC)", "para Xbox One y Xbox Series X|S", ™, comillas tipográficas, etc.

const SPANISH_WORDS = {
  estandar: 'standard', definitiva: 'definitive', oro: 'gold', dorada: 'gold', completa: 'complete',
  mejorada: 'enhanced', especial: 'special', suprema: 'ultimate', coleccionista: 'collectors',
};

export function normalizeTitle(title) {
  let t = String(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®©℠]/g, '')
    .replace(/[​-‏‪-‮⁠﻿]/g, '')
    .replace(/[’‘´`]/g, "'")
    .replace(/[–—]/g, '-');

  // Plataformas: "(PC)", "(Xbox Series)", "para Xbox One y…", "Xbox Edition", "for Windows 10"
  t = t.replace(/\([^)]*(pc|windows|xbox|series)[^)]*\)/g, ' ')
    .replace(/\b(para|for) (xbox|windows|pc)\b.*$/, ' ')
    .replace(/\bxbox (series x\|s|series x|series|one)( edition)?\b/g, ' ')
    .replace(/\b(xbox|windows|pc) edition\b/g, ' ')
    .replace(/\bwindows( 10| 11)?\b/g, ' ');

  // Ediciones en español → inglés ("edicion de lujo" → "deluxe edition")
  t = t.replace(/\bedicion de lujo\b/g, 'deluxe edition')
    .replace(/\bedicion (del )?juego del ano\b/g, 'game of the year edition')
    .replace(/\bedicion (de )?([a-z0-9]+)\b/g, (_, __, word) => `${SPANISH_WORDS[word] || word} edition`)
    .replace(/\bgoty\b/g, 'game of the year');

  // La edición estándar es el juego base
  t = t.replace(/\bstandard edition\b/g, ' ');

  return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Palabras que indican edición. Se comparan como conjunto entre Xbox y Steam: "Digital Deluxe" ≠ "Deluxe".
const EDITION_WORDS = new Set([
  'deluxe', 'gold', 'ultimate', 'premium', 'complete', 'definitive', 'goty', 'collectors', 'special', 'digital',
  'enhanced', 'reloaded', 'extras', 'legendary', 'platinum', 'vault', 'champions', 'directors', 'cut', 'anniversary',
  'expanded', 'bundle',
]);
// Si una opción de Steam es un paquete de varios juegos y el de Xbox no, no es el mismo producto
const SET_WORDS = new Set(['bundle', 'pack', 'collection', 'coleccion', 'lote', 'paquete', 'franchise', 'trilogy', 'anthology', 'saga']);

const tokens = (norm) => norm.replace(/\bgame of the year\b/g, 'goty').split(' ').filter(Boolean);
const editionSet = (norm) => new Set(tokens(norm).filter((w) => EDITION_WORDS.has(w) && w !== 'bundle'));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// "hogwarts legacy digital deluxe edition" → "hogwarts legacy" (saca la edición del final)
export function baseTitle(norm) {
  const t = tokens(norm);
  while (t.length > 1 && (EDITION_WORDS.has(t.at(-1)) || t.at(-1) === 'edition')) t.pop();
  return t.join(' ');
}

function jaccard(a, b) {
  const A = new Set(tokens(a).filter((w) => !EDITION_WORDS.has(w) && w !== 'edition'));
  const B = new Set(tokens(b).filter((w) => !EDITION_WORDS.has(w) && w !== 'edition'));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter || 1);
}

// Editores/desarrolladores: "Activision Publishing Inc." ≈ "Activision"
const COMPANY_NOISE = /\b(inc|ltd|llc|sa|srl|gmbh|co|corp|corporation|limited|games|game|studios|studio|entertainment|interactive|publishing|software|digital|productions|the)\b/g;
// Mismas empresas con nombres distintos en cada tienda
const COMPANY_ALIASES = {
  xbox: 'microsoft', wb: 'warner bros', warner: 'warner bros', zenimax: 'bethesda', 'bethesda softworks': 'bethesda',
  'take two': '2k', sie: 'sony', 'playstation publishing': 'sony',
};
const normCompany = (c) => {
  const n = String(c || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(COMPANY_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return COMPANY_ALIASES[n] || n;
};

// Devuelve el nombre de Steam de la empresa que coincide, o null
function companyMatch(xboxCompanies, steamCompanies) {
  const xs = xboxCompanies.map(normCompany).filter(Boolean);
  for (const original of steamCompanies) {
    const s = normCompany(original);
    if (!s) continue;
    for (const x of xs) {
      if (x === s || (Math.min(x.length, s.length) >= 4 && (x.includes(s) || s.includes(x)))) return original;
    }
  }
  return null;
}

// ---------- Fuentes de Steam ----------

// Lista completa de juegos de Steam (~200.000, nombres en inglés). Requiere STEAM_API_KEY.
// Se guarda en disco una semana para no bajarla en cada corrida local.
async function loadAppIndex(log) {
  if (!STEAM.apiKey) return null;
  const cacheFile = join(DATA_DIR, 'steam-applist.json');
  let apps = null;
  if (existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < 7 * 86400e3) {
    apps = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } else {
    apps = [];
    let last = 0;
    for (let page = 0; page < 20; page++) {
      const { response } = await getJson(`https://api.steampowered.com/IStoreService/GetAppList/v1/?key=${encodeURIComponent(STEAM.apiKey)}`
        + `&include_games=true&include_dlc=false&include_software=false&max_results=50000&last_appid=${last}`, 60_000);
      for (const a of response.apps || []) apps.push([a.appid, a.name]);
      if (!response.have_more_results) break;
      last = response.last_appid;
    }
    writeFileSync(cacheFile, JSON.stringify(apps));
    log(`[steam] lista de juegos de Steam descargada: ${apps.length}`);
  }
  const index = new Map();
  for (const [appid, name] of apps) {
    const key = normalizeTitle(name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(appid);
  }
  return index;
}

// Datos de la tienda en lote (100 por pedido): nombre, editor, desarrollador y todas las ediciones con precio
async function getItems(appids, { cc, lang }) {
  const out = new Map();
  for (let i = 0; i < appids.length; i += 100) {
    const input = {
      ids: appids.slice(i, i + 100).map((appid) => ({ appid })),
      context: { language: lang, country_code: cc.toUpperCase() },
      data_request: { include_basic_info: true, include_all_purchase_options: true },
    };
    const { response } = await getJson(
      `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`
    );
    for (const it of response.store_items || []) if (it.success === 1 && it.visible !== false) out.set(it.appid, it);
    if (i + 100 < appids.length) await sleep(1000);
  }
  return out;
}

const optionKey = (o) => (o.packageid ? `sub:${o.packageid}` : `bundle:${o.bundleid}`);

// Elige la opción de compra de Steam que corresponde a la edición de Xbox
function pickOption(item, xboxNorm) {
  const options = (item.purchase_options || []).filter((o) => o.final_price_in_cents !== undefined);
  const xboxEdition = editionSet(xboxNorm);
  const xboxIsSet = tokens(xboxNorm).some((w) => SET_WORDS.has(w));
  const candidates = options
    .map((o) => ({ o, norm: normalizeTitle(o.purchase_option_name) }))
    .filter(({ norm }) => xboxIsSet || !tokens(norm).some((w) => SET_WORDS.has(w)))
    .filter(({ o }) => !o.included_game_count || o.included_game_count <= 1 || xboxIsSet)
    .map((c) => ({ ...c, score: jaccard(c.norm, xboxNorm) }))
    .filter((c) => c.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  const same = candidates.find((c) => sameSet(editionSet(c.norm), xboxEdition));
  if (same) return { option: same.o, edition: 'same' };
  // Xbox vende una edición especial que Steam no tiene: se muestra la estándar solo como referencia
  const standard = candidates.find((c) => editionSet(c.norm).size === 0);
  if (standard && xboxEdition.size) return { option: standard.o, edition: 'standard_only' };
  return null;
}

async function searchStore(term, { cc, lang }) {
  const { items = [] } = await getJson(`${STORE}/storesearch/?term=${encodeURIComponent(term)}&cc=${cc}&l=${lang}`);
  return items.filter((i) => i.type === 'app');
}

// ---------- Emparejamiento Xbox → Steam ----------

function loadOverrides() {
  if (!existsSync(OVERRIDES_FILE)) return {};
  const raw = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

const saveMatch = db.prepare(`
  INSERT INTO steam_matches (product_id, steam_appid, steam_name, item_key, item_name, edition, company, reason, method, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(product_id) DO UPDATE SET steam_appid=excluded.steam_appid, steam_name=excluded.steam_name,
    item_key=excluded.item_key, item_name=excluded.item_name, edition=excluded.edition, company=excluded.company,
    reason=excluded.reason, method=excluded.method, checked_at=excluded.checked_at
`);

export async function matchSteam(locale = DEFAULT_LOCALE, log = console.log) {
  const market = STEAM.markets[locale] || STEAM.markets[DEFAULT_LOCALE];
  const now = new Date().toISOString();
  const overrides = loadOverrides();

  // Juegos sin emparejar, los que no se encontraron hace más de N días y las correcciones manuales nuevas
  const retryBefore = new Date(Date.now() - STEAM.retryUnmatchedDays * 86400e3).toISOString();
  const pending = db.prepare(`
    SELECT p.id, p.title, p.publisher, p.developer, m.method, m.steam_appid FROM prices pr JOIN products p ON p.id = pr.product_id
    LEFT JOIN steam_matches m ON m.product_id = p.id
    LEFT JOIN rankings r ON r.product_id = p.id AND r.locale = pr.locale AND r.list IN ('popular', 'wishlisted')
    WHERE pr.locale = ? AND (m.product_id IS NULL OR (m.method = 'auto' AND m.steam_appid IS NULL AND m.checked_at < ?))
    GROUP BY p.id
    ORDER BY MIN(COALESCE(r.position, 99999)), MAX(pr.discount) DESC
  `).all(locale, retryBefore);
  for (const id of Object.keys(overrides)) {
    const m = db.prepare("SELECT method, steam_appid FROM steam_matches WHERE product_id = ?").get(id);
    const p = db.prepare('SELECT id, title, publisher, developer FROM products WHERE id = ?').get(id);
    if (p && (m?.method !== 'manual' || m.steam_appid !== overrides[id]) && !pending.some((x) => x.id === id)) pending.push(p);
  }
  if (!pending.length) return;

  // 1) Candidatos: nombre exacto en la lista completa (instantáneo) o, si no hay key o no aparece, búsqueda en la tienda
  const index = await loadAppIndex(log).catch((err) => { log(`[steam] sin lista completa (${err.message})`); return null; });
  let searches = 0;
  const work = [];
  for (const p of pending) {
    const norm = normalizeTitle(p.title);
    const base = baseTitle(norm);
    let candidates = [];
    if (p.id in overrides) {
      candidates = overrides[p.id] ? [overrides[p.id]] : [];
    } else {
      candidates = [...new Set([...(index?.get(norm) || []), ...(index?.get(base) || [])])];
      if (!candidates.length && searches < STEAM.matchesPerRun) {
        try {
          for (const lang of [...new Set([market.lang, 'english'])]) {
            searches++;
            const found = await searchStore(base, { ...market, lang });
            candidates = found.filter((i) => [norm, base].includes(normalizeTitle(i.name))).map((i) => i.id);
            await sleep(STEAM.searchDelayMs);
            if (candidates.length || lang === 'english') break;
          }
        } catch (err) {
          log(`[steam] búsqueda interrumpida (${err.message})`);
          searches = Infinity;
        }
      } else if (!candidates.length && !index) {
        continue; // sin key y sin presupuesto de búsquedas: queda para la próxima
      }
    }
    work.push({ p, norm, candidates: candidates.slice(0, 5) });
  }

  // 2) Verificación en lote: editor/desarrollador y edición
  const items = await getItems([...new Set(work.flatMap((w) => w.candidates))], market);
  let found = 0;
  let sameEdition = 0;
  const priced = [];
  transaction(() => {
    for (const { p, norm, candidates } of work) {
      const manual = p.id in overrides;
      let result = null;
      let reason = candidates.length ? 'company' : 'not_found';
      for (const appid of candidates) {
        const item = items.get(appid);
        if (!item) continue;
        const info = item.basic_info || {};
        const steamCompanies = [...(info.publishers || []), ...(info.developers || [])].map((c) => c.name);
        const company = companyMatch([p.publisher, p.developer], steamCompanies);
        // Sin coincidencia de empresa (distribuidoras regionales, ports): se acepta solo si el nombre es
        // idéntico, único en Steam y no genérico (más de una palabra o al menos 8 letras)
        const sameName = [norm, baseTitle(norm)].includes(normalizeTitle(item.name));
        const distinctive = tokens(norm).length >= 2 || norm.length >= 8;
        if (!company && !manual && !(sameName && candidates.length === 1 && distinctive)) continue;
        const option = pickOption(item, norm);
        result = { item, company: company || null, ...(option || {}) };
        if (option) break;
      }
      if (!result) {
        saveMatch.run(p.id, null, null, null, null, null, null, reason, manual ? 'manual' : 'auto', now);
        continue;
      }
      found++;
      if (result.edition === 'same') sameEdition++;
      const key = result.option ? optionKey(result.option) : null;
      saveMatch.run(p.id, result.item.appid, result.item.name, key, result.option?.purchase_option_name ?? null,
        result.edition ?? null, result.company, null, manual ? 'manual' : 'auto', now);
      if (key) priced.push([key, result.option]);
    }
    for (const [key, option] of priced) saveSteamPrice(key, market, option, now);
  });
  log(`[steam] ${work.length} revisados (${searches === Infinity ? 'búsqueda cortada' : `${searches} búsquedas`}): `
    + `${found} emparejados, ${sameEdition} con la misma edición`);
}

// ---------- Precios en Steam ----------

const getSteamPrice = db.prepare('SELECT * FROM steam_prices WHERE item_key = ? AND cc = ?');
const insertSteamPrice = db.prepare(`
  INSERT INTO steam_prices (item_key, cc, currency, price, msrp, discount, previous_price, lowest_price, changed_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
`);
const updateSteamPrice = db.prepare(`
  UPDATE steam_prices SET currency=?, price=?, msrp=?, discount=?, previous_price=?, lowest_price=?, changed_at=?, last_seen=?
  WHERE item_key=? AND cc=?
`);
const markNoPrice = db.prepare(`
  INSERT INTO steam_prices (item_key, cc, last_seen) VALUES (?, ?, ?)
  ON CONFLICT(item_key, cc) DO UPDATE SET price=NULL, msrp=NULL, discount=NULL, last_seen=excluded.last_seen
`);
const insertSteamHistory = db.prepare('INSERT INTO steam_history (item_key, cc, price, discount, recorded_at) VALUES (?, ?, ?, ?, ?)');

function saveSteamPrice(key, market, option, now) {
  const price = option.final_price_in_cents / 100;
  const msrp = (option.original_price_in_cents ?? option.final_price_in_cents) / 100;
  const discount = option.discount_pct ?? 0;
  const current = getSteamPrice.get(key, market.cc);
  if (!current || current.price === null) {
    if (current) db.prepare('DELETE FROM steam_prices WHERE item_key = ? AND cc = ?').run(key, market.cc);
    insertSteamPrice.run(key, market.cc, market.currency, price, msrp, discount, price, now, now);
    insertSteamHistory.run(key, market.cc, price, discount, now);
    return;
  }
  const changed = current.price !== price;
  updateSteamPrice.run(market.currency, price, msrp, discount,
    changed ? current.price : current.previous_price,
    Math.min(current.lowest_price ?? price, price),
    changed ? now : current.changed_at,
    now, key, market.cc);
  if (changed) insertSteamHistory.run(key, market.cc, price, discount, now);
}

// Actualiza el precio de cada edición emparejada (100 juegos por pedido)
export async function updateSteamPrices(locale, log = console.log) {
  const market = STEAM.markets[locale];
  if (!market) return;
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT DISTINCT m.steam_appid AS appid, m.item_key FROM steam_matches m
    JOIN prices pr ON pr.product_id = m.product_id AND pr.locale = ?
    WHERE m.item_key IS NOT NULL
  `).all(locale);
  if (!rows.length) return;
  let items;
  try {
    items = await getItems([...new Set(rows.map((r) => r.appid))], market);
  } catch (err) {
    log(`[steam] precios interrumpidos (${err.message})`);
    return;
  }
  let updated = 0;
  transaction(() => {
    for (const { appid, item_key: key } of rows) {
      const item = items.get(appid);
      if (!item) continue; // error puntual: se reintenta la próxima vez
      const option = (item.purchase_options || []).find((o) => optionKey(o) === key && o.final_price_in_cents !== undefined);
      if (option) { saveSteamPrice(key, market, option, now); updated++; } else markNoPrice.run(key, market.cc, now);
    }
  });
  log(`[steam] [${locale}] precios actualizados: ${updated}/${rows.length}`);
}

// ---------- Tipo de cambio ----------
// En Argentina Steam cobra en USD y Xbox en ARS. Como ambos llevan los mismos impuestos (IVA + IIBB),
// se comparan los precios base convirtiendo con el dólar elegido (por defecto, oficial venta).

export async function updateFxRate() {
  const now = new Date().toISOString();
  try {
    const res = await fetch(`https://dolarapi.com/v1/dolares/${encodeURIComponent(STEAM.dollarType)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`dolarapi respondió ${res.status}`);
    const { venta } = await res.json();
    if (!(venta > 0)) throw new Error('cotización inválida');
    db.prepare(`INSERT INTO fx_rates VALUES ('USD-ARS', ?, ?, ?)
      ON CONFLICT(pair) DO UPDATE SET rate=excluded.rate, source=excluded.source, fetched_at=excluded.fetched_at`)
      .run(venta, `dólar ${STEAM.dollarType}`, now);
  } catch (err) {
    console.error('[fx] No se pudo actualizar el dólar, se usa el último conocido:', err.message);
  }
}

// Factor para pasar un precio de Steam a la moneda de Xbox (null = no se puede comparar)
export function fxRate(from, to) {
  if (from === to) return { rate: 1 };
  if (from === 'USD' && to === 'ARS') {
    const row = db.prepare("SELECT * FROM fx_rates WHERE pair = 'USD-ARS'").get();
    return row ? { rate: row.rate, source: row.source, fetchedAt: row.fetched_at } : null;
  }
  return null;
}

// ---------- Comparación para un producto ----------

const steamForProduct = db.prepare(`
  SELECT m.*, sp.item_key AS priced, sp.currency, sp.price, sp.msrp, sp.discount, sp.previous_price, sp.lowest_price
  FROM steam_matches m LEFT JOIN steam_prices sp ON sp.item_key = m.item_key AND sp.cc = ?
  WHERE m.product_id = ?
`);

// Estado de Steam para un juego: pending (todavía no se buscó), notFound (no está en Steam o no se pudo
// confirmar que sea el mismo), noPrice (está pero sin precio en ese país), priced (comparación completa)
export function steamStatus(productId, locale) {
  const market = STEAM.markets[locale];
  if (!market) return { status: 'notFound' };
  const s = steamForProduct.get(market.cc, productId);
  if (!s) return { status: 'pending' };
  const match = s.steam_appid ? { appid: s.steam_appid, name: s.steam_name, itemName: s.item_name, company: s.company } : {};
  if (!s.steam_appid) return { status: 'notFound', reason: s.reason };
  if (!s.item_key) return { status: 'noPrice', ...match };
  if (!s.priced) return { status: 'pending', ...match };
  if (s.price === null) return { status: 'noPrice', ...match };
  return { status: 'priced', ...match, row: s };
}

// Datos de Steam del juego y cuál tienda conviene, o null si no hay precio para comparar
export function steamComparison(productId, locale, xbox) {
  const { status, row: s, ...match } = steamStatus(productId, locale);
  if (status !== 'priced') return null;
  const fx = fxRate(s.currency, xbox.currency);
  const local = fx ? Math.round(s.price * fx.rate * 100) / 100 : null;
  let cheaper = null;
  let diffPct = null;
  // Si Steam no tiene la misma edición, el precio es solo referencia: no se dice cuál conviene
  if (s.edition === 'same' && local !== null && xbox.price > 0 && local > 0) {
    diffPct = Math.round(((xbox.price - local) / Math.max(xbox.price, local)) * 100);
    cheaper = Math.abs(diffPct) < 3 ? 'equal' : xbox.price < local ? 'xbox' : 'steam';
  }
  return {
    ...match,
    itemKey: s.item_key,
    edition: s.edition,
    currency: s.currency,
    price: s.price,
    msrp: s.msrp,
    discount: s.discount,
    previousPrice: s.previous_price,
    lowestPrice: s.lowest_price,
    dropped: s.previous_price !== null && s.price < s.previous_price,
    priceLocal: local,
    cheaper,
    // Tope 99%: "100% menos" se lee como gratis (pasa con precios viejos de Xbox Argentina, ej. $14 vs USD 15)
    diffPct: diffPct === null ? null : Math.min(99, Math.abs(diffPct)),
  };
}

export function steamHistory(itemKey, locale) {
  const market = STEAM.markets[locale];
  return db.prepare('SELECT recorded_at, price, discount FROM steam_history WHERE item_key = ? AND cc = ? ORDER BY recorded_at')
    .all(itemKey, market.cc).map((h) => [h.recorded_at, h.price, h.discount]);
}

// Todo junto, después de actualizar los precios de Xbox de un mercado
let steamRunning = false;
export async function updateSteam(locale, log = console.log) {
  if (steamRunning) return log('[steam] ya hay una actualización de Steam en curso');
  steamRunning = true;
  try {
    if (locale === 'es-AR') await updateFxRate();
    await updateSteamPrices(locale, log); // primero lo ya emparejado (rápido)
    await matchSteam(locale, log);        // después los juegos nuevos (ya quedan con precio)
  } finally {
    steamRunning = false;
  }
}
