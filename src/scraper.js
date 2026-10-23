import { db, transaction } from './db.js';
import { LISTS } from './config.js';

// API interna que usa xbox.com/games/browse (la de "reco-public" de Microsoft Store está deprecada)
const BROWSE_URL = 'https://emerald.xboxservices.com/xboxcomfd/browse';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reintenta ante errores de red, 429 o 5xx esperando cada vez más (1 s, 4 s, 9 s)
async function fetchPage(locale, orderby, encodedCT, attempt = 1) {
  try {
    return await fetchPageOnce(locale, orderby, encodedCT);
  } catch (err) {
    if (attempt >= 3 || err.retryable === false) throw err;
    await sleep(1000 * attempt ** 2);
    return fetchPage(locale, orderby, encodedCT, attempt + 1);
  }
}

async function fetchPageOnce(locale, orderby, encodedCT) {
  const filters = { orderby: { id: 'orderby', choices: [{ id: orderby }] } };
  const res = await fetch(`${BROWSE_URL}?locale=${encodeURIComponent(locale)}`, {
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ms-api-version': '1.1',
      'ms-cv': `store-sales.${Date.now()}`,
    },
    body: JSON.stringify({
      Filters: Buffer.from(JSON.stringify(filters)).toString('base64'),
      ReturnFilters: false,
      ChannelKeyToBeUsedInResponse: 'LIST',
      EncodedCT: encodedCT || '',
      ChannelId: '',
    }),
  });
  if (!res.ok) {
    const err = new Error(`Xbox browse API respondió ${res.status}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const json = await res.json();
  const channel = json.channels?.LIST;
  return {
    products: json.productSummaries || [],
    encodedCT: channel?.encodedCT,
    hasMore: Boolean(channel?.encodedCT) && (json.productSummaries || []).length > 0,
  };
}

function pickSku(p) {
  const skus = p.specificPrices?.purchaseable || [];
  return skus.find((s) => s.skuId === p.preferredSkuId) || skus[0] || null;
}

function normalize(p) {
  const sku = pickSku(p);
  if (!sku) return null;
  const endDate = new Date(sku.endDateUtc + ' UTC');
  const isSale = sku.discountPercentage > 0 && sku.listPrice < sku.msrp;
  return {
    id: p.productId,
    title: p.title,
    publisher: p.publisherName || p.developerName || '',
    developer: p.developerName || '',
    image: p.images?.poster?.url || p.images?.boxArt?.url
      || Object.values(p.images || {}).flat().find((img) => img?.url)?.url || '',
    categories: JSON.stringify(p.categories || []),
    platforms: JSON.stringify(p.availableOn || []),
    rating: p.averageRating ?? null,
    ratingCount: p.ratingCount ?? 0,
    releaseDate: p.releaseDate || null,
    gamePass: (p.includedWithPassesProductIds || []).length > 0 ? 1 : 0,
    currency: sku.currency,
    price: sku.listPrice,
    msrp: sku.msrp,
    discount: isSale ? Math.max(1, Math.floor(sku.discountPercentage)) : 0,
    saleEnd: isSale && endDate.getFullYear() < 9000 ? endDate.toISOString() : null,
    rawDiscount: sku.discountPercentage || 0,
  };
}

const upsertProduct = db.prepare(`
  INSERT INTO products (id, title, publisher, image, categories, platforms, rating, rating_count, release_date, game_pass, developer)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, publisher=excluded.publisher, image=excluded.image,
    categories=excluded.categories, platforms=excluded.platforms, rating=excluded.rating,
    rating_count=excluded.rating_count, release_date=excluded.release_date, game_pass=excluded.game_pass,
    developer=excluded.developer
`);
const getPrice = db.prepare('SELECT * FROM prices WHERE product_id = ? AND locale = ?');
const insertPrice = db.prepare(`
  INSERT INTO prices (product_id, locale, currency, price, msrp, discount, sale_end, previous_price, changed_at, lowest_price, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
`);
const updatePrice = db.prepare(`
  UPDATE prices SET currency=?, price=?, msrp=?, discount=?, sale_end=?, previous_price=?, changed_at=?, lowest_price=?, last_seen=?
  WHERE product_id=? AND locale=?
`);
const insertHistory = db.prepare(
  'INSERT INTO price_history (product_id, locale, price, msrp, discount, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const upsertRanking = db.prepare(`
  INSERT INTO rankings (product_id, locale, list, position) VALUES (?, ?, ?, ?)
  ON CONFLICT(product_id, locale, list) DO UPDATE SET position=excluded.position
`);

// Guarda el producto y registra el cambio de precio si lo hubo.
// Devuelve null si no cambió, o { oldPrice, newPrice } si cambió.
function savePrice(locale, item, now) {
  upsertProduct.run(item.id, item.title, item.publisher, item.image, item.categories, item.platforms,
    item.rating, item.ratingCount, item.releaseDate, item.gamePass, item.developer);

  const current = getPrice.get(item.id, locale);
  if (!current) {
    insertPrice.run(item.id, locale, item.currency, item.price, item.msrp, item.discount, item.saleEnd,
      now, item.price, now, now);
    insertHistory.run(item.id, locale, item.price, item.msrp, item.discount, now);
    return null;
  }
  const changed = current.price !== item.price;
  updatePrice.run(item.currency, item.price, item.msrp, item.discount, item.saleEnd,
    changed ? current.price : current.previous_price,
    changed ? now : current.changed_at,
    Math.min(current.lowest_price ?? item.price, item.price),
    now, item.id, locale);
  if (!changed) return null;
  insertHistory.run(item.id, locale, item.price, item.msrp, item.discount, now);
  return { oldPrice: current.price, newPrice: item.price };
}

let running = false;
export const isScraping = () => running;

// Funciones a llamar al terminar cada actualización (ej: alertas de Discord)
const listeners = [];
export const onScrapeDone = (fn) => listeners.push(fn);

export async function scrape(locale, log = console.log) {
  if (running) throw new Error('Ya hay una actualización en curso');
  running = true;
  const startedAt = new Date().toISOString();
  const seen = new Set();
  let changes = 0;
  let dealsComplete = false;
  const drops = []; // juegos que bajaron de precio en esta actualización

  try {
    for (const [listName, cfg] of Object.entries(LISTS)) {
      const ranking = []; // se escribe entero al final para no dejar la lista a medias
      let ct = '';
      for (let page = 0; page < cfg.maxPages; page++) {
        const { products, encodedCT, hasMore } = await fetchPage(locale, cfg.orderby, ct);
        let reachedNoDiscount = false;
        transaction(() => {
          for (const p of products) {
            const item = normalize(p);
            if (!item) continue;
            if (cfg.stopWhenNoDiscount && item.rawDiscount === 0) { reachedNoDiscount = true; break; }
            const change = savePrice(locale, item, startedAt);
            if (change) {
              changes++;
              if (change.newPrice < change.oldPrice) drops.push({ ...item, oldPrice: change.oldPrice });
            }
            seen.add(item.id);
            ranking.push(item.id);
          }
        });
        if (reachedNoDiscount || !hasMore) {
          if (cfg.stopWhenNoDiscount) dealsComplete = true;
          break;
        }
        ct = encodedCT;
        await sleep(250);
      }
      transaction(() => {
        db.prepare('DELETE FROM rankings WHERE locale = ? AND list = ?').run(locale, listName);
        ranking.forEach((id, i) => upsertRanking.run(id, locale, listName, i + 1));
      });
      log(`[${locale}] lista "${listName}": ${ranking.length} juegos`);
    }

    // Si recorrimos todas las ofertas, las que estaban en oferta y ya no aparecen terminaron:
    // el precio vuelve al original (msrp).
    if (dealsComplete) {
      const expired = db.prepare('SELECT * FROM prices WHERE locale = ? AND discount > 0').all(locale)
        .filter((row) => !seen.has(row.product_id));
      transaction(() => {
        for (const row of expired) {
          db.prepare(`UPDATE prices SET price=msrp, discount=0, sale_end=NULL, previous_price=price, changed_at=?
                      WHERE product_id=? AND locale=?`).run(startedAt, row.product_id, locale);
          insertHistory.run(row.product_id, locale, row.msrp, row.msrp, 0, startedAt);
          changes++;
        }
      });
      if (expired.length) log(`[${locale}] ${expired.length} ofertas terminaron`);
    }

    db.prepare('INSERT INTO scrape_runs VALUES (?, ?, ?, ?, ?, NULL)')
      .run(locale, startedAt, new Date().toISOString(), seen.size, changes);
    log(`[${locale}] listo: ${seen.size} juegos, ${changes} cambios de precio, ${drops.length} bajadas`);
    const result = { locale, products: seen.size, changes, drops };
    for (const fn of listeners) {
      try { await fn(result); } catch (err) { console.error('Error en listener de scrape:', err.message); }
    }
    return result;
  } catch (err) {
    db.prepare('INSERT INTO scrape_runs VALUES (?, ?, ?, ?, ?, ?)')
      .run(locale, startedAt, new Date().toISOString(), seen.size, changes, String(err.message));
    throw err;
  } finally {
    running = false;
  }
}
