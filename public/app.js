const $ = (id) => document.getElementById(id);

const PLATFORM_NAMES = {
  XboxSeriesX: 'Series X|S', XboxOne: 'Xbox One', PC: 'PC', XCloud: 'Cloud', Handheld: 'Handheld',
};
const PAGE_SIZE = 48;

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
};

const state = {
  locale: store.get('locale', null),
  view: 'deals',
  page: 1,
  following: new Set(store.get('following', [])),
  meta: null,
  data: null,        // JSON del mercado actual: { currency, updatedAt, games: [...] }
  byId: new Map(),
  server: false,     // true si corre con el servidor Node (hay botón de actualizar)
};

function money(value, currency = state.data?.currency) {
  if (value === 0) return 'Gratis';
  try {
    return new Intl.NumberFormat(state.locale, { style: 'currency', currency, maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

function timeAgo(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

function daysLeft(iso) {
  const d = Math.ceil((new Date(iso) - Date.now()) / 86400000);
  return d <= 0 ? 'termina hoy' : d === 1 ? 'termina mañana' : `termina en ${d} días`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function imageUrl(url, w = 300) {
  return url ? escapeHtml(`${url}?q=80&w=${w}&h=${Math.round(w * 1.5)}`) : '';
}

async function getJson(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ---------- Datos ----------

async function loadData() {
  // Rutas relativas para que funcione también en un subdirectorio (usuario.github.io/repo/)
  state.data = await getJson(`data/${encodeURIComponent(state.locale)}.json`);
  state.byId = new Map(state.data.games.map((g) => [g.id, g]));

  const genres = [...new Set(state.data.games.flatMap((g) => g.categories))].sort((a, b) => a.localeCompare(b));
  const genreSel = $('genre');
  const current = genreSel.value;
  genreSel.innerHTML = '<option value="">Todos los géneros</option>' +
    genres.map((g) => `<option>${escapeHtml(g)}</option>`).join('');
  genreSel.value = genres.includes(current) ? current : '';

  const games = state.data.games;
  $('count-deals').textContent = games.filter((g) => g.discount > 0).length || '';
  $('count-drops').textContent = games.filter((g) => g.dropped).length || '';
  renderStatus();
}

function renderStatus(serverStatus) {
  const d = state.data;
  if (serverStatus?.scraping) {
    $('status').textContent = 'Actualizando precios desde Microsoft Store…';
  } else {
    $('status').textContent = d?.updatedAt
      ? `${d.games.length} juegos · actualizado ${timeAgo(d.updatedAt)}${d.lastError ? ' (con error)' : ''} · auto cada ${state.meta.refreshHours} h`
        + (d.fx ? ` · Steam: ${d.fx.from} 1 = ${money(d.fx.rate)} (${d.fx.source})` : '')
      : 'Sin datos todavía para este mercado.';
  }
  const btn = $('refresh');
  btn.hidden = !state.server;
  if (!state.server || !serverStatus) return;
  const waitMin = serverStatus.nextManualRefresh ? Math.ceil((new Date(serverStatus.nextManualRefresh) - Date.now()) / 60000) : 0;
  btn.disabled = serverStatus.scraping || waitMin > 0;
  btn.textContent = serverStatus.scraping ? 'Actualizando…' : waitMin > 0 ? `Actualizar en ${waitMin} min` : 'Actualizar precios';
  btn.title = waitMin > 0 ? 'Para no saturar a Microsoft, se puede actualizar a mano cada cierto tiempo' : '';
}

// ---------- Filtros y orden (todo en el navegador) ----------

const rank = (g, list) => g.ranks[list] ?? Infinity;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SORTS = {
  discount: (a, b) => b.discount - a.discount || a.price - b.price,
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
  drop: (a, b) => dropPct(b) - dropPct(a),
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.ratingCount - a.ratingCount,
  newest: (a, b) => cmp(b.releaseDate ?? '', a.releaseDate ?? ''),
  title: (a, b) => a.title.localeCompare(b.title),
  popular: (a, b) => rank(a, 'popular') - rank(b, 'popular'),
  wishlisted: (a, b) => rank(a, 'wishlisted') - rank(b, 'wishlisted'),
  sale_end: (a, b) => cmp(a.saleEnd ?? '9999', b.saleEnd ?? '9999'),
  steam_diff: (a, b) => (b.steam?.diffPct ?? -1) - (a.steam?.diffPct ?? -1),
};

// Filtro "Comparación con Steam"
const STEAM_FILTERS = {
  has: (g) => g.steam.status === 'priced',
  xbox: (g) => g.steam?.cheaper === 'xbox',
  steam: (g) => g.steam?.cheaper === 'steam',
  steamSale: (g) => g.steam?.discount > 0,
  bothSale: (g) => g.discount > 0 && g.steam?.discount > 0,
};
const dropPct = (g) => (g.previousPrice ? (g.previousPrice - g.price) / g.previousPrice : 0);

// Pestañas: cada una tiene un filtro y un orden por defecto
const VIEWS = {
  all: { filter: () => true, sort: 'popular' },
  deals: { filter: (g) => g.discount > 0, sort: 'discount' },
  drops: { filter: (g) => g.dropped, sort: 'drop' },
  lowest: { filter: (g) => g.isLowest, sort: 'discount' },
  popular: { filter: (g) => g.ranks.popular, sort: 'popular' },
  wishlisted: { filter: (g) => g.ranks.wishlisted, sort: 'wishlisted' },
  newest: { filter: (g) => g.ranks.newest, sort: 'newest' },
  free: { filter: (g) => g.price === 0, sort: 'popular' },
  following: { filter: (g) => state.following.has(g.id), sort: 'title' },
};

function filteredGames() {
  const view = VIEWS[state.view];
  const q = $('q').value.trim().toLowerCase();
  const platform = $('platform').value;
  const genre = $('genre').value;
  const gamePass = $('gamePass').value;
  const minDiscount = Number($('minDiscount').value);
  const steamFilter = STEAM_FILTERS[$('steam').value];
  const sort = SORTS[$('sort').value || view.sort];

  return state.data.games
    .filter((g) => view.filter(g)
      && (!q || g.title.toLowerCase().includes(q))
      && (!platform || g.platforms.includes(platform))
      && (!genre || g.categories.includes(genre))
      && (!gamePass || g.gamePass === (gamePass === '1'))
      && (!steamFilter || steamFilter(g))
      && g.discount >= minDiscount)
    .sort((a, b) => sort(a, b) || a.title.localeCompare(b.title));
}

// ---------- Listado ----------

const VERDICT = { xbox: 'Xbox', steam: 'Steam', equal: 'Mismo precio' };
const STEAM_STATUS_TEXT = {
  pending: 'buscando…',
  notFound: 'no está en Steam',
  noPrice: 'sin precio en Steam',
};
const steamStatusText = (s) => (s.status === 'notFound' && s.reason === 'company'
  ? 'sin coincidencia segura' : STEAM_STATUS_TEXT[s.status]);

// Link para abrir un issue en GitHub con los datos del juego ya completados
function reportUrl(g) {
  const repo = state.data.reportRepo;
  if (!repo) return null;
  const s = g.steam;
  const steam = s.appid ? `${s.itemName || s.name} (appid ${s.appid}, https://store.steampowered.com/app/${s.appid})` : steamStatusText(s);
  const body = [
    `**Xbox:** ${g.title} (ID \`${g.id}\`)`,
    `**Steam:** ${steam}`,
    '',
    '**¿Qué está mal?** (ej. es otro juego, otra edición, sí está en Steam: pegá el link)',
    '',
    '',
    '---',
    `Para corregirlo, en \`steam-overrides.json\`: \`"${g.id}": APPID_CORRECTO\` o \`"${g.id}": null\` si no tiene equivalente.`,
  ].join('\n');
  const params = new URLSearchParams({ title: `Comparación incorrecta: ${g.title}`, body, labels: 'steam' });
  return `https://github.com/${repo}/issues/new?${params}`;
}

function steamPrice(s, value = s.price) {
  const factor = s.priceLocal !== null && s.price ? s.priceLocal / s.price : null;
  return factor ? money(Math.round(value * factor * 100) / 100) : `${s.currency} ${value}`;
}

// Una fila por tienda: nombre, precio, precio tachado y descuento. La más barata se resalta.
function storeRow(name, cls, { price, msrp, discount }, best) {
  return `<div class="store-row ${cls} ${best ? 'best' : ''}">
    <span class="store">${name}</span>
    <span class="price ${price === 'Gratis' ? 'free' : ''}">${price}</span>
    ${msrp ? `<span class="old">${msrp}</span>` : ''}
    ${discount > 0 ? `<span class="off ${cls}">-${discount}%</span>` : ''}
  </div>`;
}

function card(g) {
  const s = g.steam;
  const badges = [];
  if (g.discount > 0) badges.push(`<span class="badge sale">Xbox -${g.discount}%</span>`);
  if (s.discount > 0) badges.push(`<span class="badge steam">Steam -${s.discount}%</span>`);
  if (g.dropped) badges.push(`<span class="badge drop">↓ Bajó</span>`);
  if (g.isLowest) badges.push(`<span class="badge lowest">Mínimo histórico</span>`);
  if (g.gamePass) badges.push(`<span class="badge gp">Game Pass</span>`);
  const on = state.following.has(g.id);
  const xboxRow = storeRow('Xbox', 'xbox', {
    price: money(g.price),
    msrp: g.msrp > g.price ? money(g.msrp) : (!g.discount && g.dropped ? money(g.previousPrice) : ''),
    discount: g.discount,
  }, s.cheaper === 'xbox');
  const steamRow = s.status === 'priced'
    ? storeRow('Steam', 'steam', {
      price: s.price === 0 ? 'Gratis' : steamPrice(s),
      msrp: s.msrp > s.price ? steamPrice(s, s.msrp) : '',
      discount: s.discount,
    }, s.cheaper === 'steam')
    : `<div class="store-row steam muted"><span class="store">Steam</span><span>${steamStatusText(s)}</span></div>`;
  const editionNote = s.edition === 'standard_only' ? '<div class="meta">Steam: solo edición estándar (referencia)</div>' : '';
  return `
    <article class="card" data-id="${escapeHtml(g.id)}">
      <div class="cover">
        ${g.image ? `<img loading="lazy" src="${imageUrl(g.image)}" alt="">` : ''}
        <div class="badges">${badges.join('')}</div>
        <button class="star ${on ? 'on' : ''}" data-star="${escapeHtml(g.id)}" title="${on ? 'Dejar de seguir' : 'Seguir este juego'}">${on ? '★' : '☆'}</button>
      </div>
      <div class="info">
        <div class="title">${escapeHtml(g.title)}</div>
        <div class="meta">${g.discount > 0 && g.saleEnd ? `Oferta Xbox ${daysLeft(g.saleEnd)}` : escapeHtml(g.publisher)}</div>
        <div class="store-rows">${xboxRow}${steamRow}</div>
        ${editionNote}
        ${s.cheaper ? `<div class="verdict ${s.cheaper}">${s.cheaper === 'equal' ? '= Mismo precio' : `✓ ${VERDICT[s.cheaper]} ${s.diffPct}% menos`}</div>` : ''}
      </div>
    </article>`;
}

function render({ append = false } = {}) {
  if (!append) state.page = 1;
  const grid = $('grid');
  if (state.view === 'following' && !state.following.size) {
    grid.innerHTML = '<p class="empty">Todavía no seguís ningún juego. Tocá ☆ en cualquier juego para seguirlo.</p>';
    $('resultInfo').textContent = '';
    $('more').hidden = true;
    return;
  }
  const games = filteredGames();
  const slice = games.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
  const html = slice.map(card).join('');
  grid.innerHTML = append ? grid.innerHTML + html : (html || '<p class="empty">No hay juegos con estos filtros.</p>');
  $('resultInfo').textContent = `${games.length} juegos`;
  $('more').hidden = state.page * PAGE_SIZE >= games.length;
}

// ---------- Detalle con historial ----------

// Historial escalonado (el precio se mantiene hasta el siguiente cambio). Si hay Steam, segunda línea
// convertida con el tipo de cambio actual.
function historyChart(g) {
  const toPoints = (history, factor = 1) =>
    history.map(([recorded_at, price, discount]) => ({ t: new Date(recorded_at).getTime(), price: price * factor, discount }));
  const series = [{ name: 'Xbox', color: '#2fbf3b', points: toPoints(g.history) }];
  const factor = g.steam.status === 'priced' && g.steam.priceLocal !== null ? g.steam.priceLocal / g.steam.price || 1 : null;
  if (g.steam.history?.length && factor) {
    series.push({ name: 'Steam', color: '#66c0f4', points: toPoints(g.steam.history, factor) });
  }
  if (series.every((s) => s.points.length < 2) && series.length === 1) {
    return '<p class="note">Todavía hay un solo registro de precio. El historial se arma con cada actualización (cada vez que cambia el precio se guarda un punto).</p>';
  }
  const W = 700, H = 180, P = { l: 70, r: 12, t: 12, b: 24 };
  const now = Date.now();
  const all = series.flatMap((s) => s.points);
  const x0 = Math.min(...all.map((p) => p.t));
  const yMax = Math.max(g.msrp, (g.steam?.msrp ?? 0) * (factor || 0), ...all.map((p) => p.price)) * 1.05 || 1;
  const sx = (x) => P.l + ((x - x0) / (now - x0 || 1)) * (W - P.l - P.r);
  const sy = (y) => P.t + (1 - y / yMax) * (H - P.t - P.b);
  const fmt = (t) => new Date(t).toLocaleDateString(state.locale, { day: 'numeric', month: 'short' });
  const ticks = [0, yMax / 2, yMax].map((v) =>
    `<text x="${P.l - 8}" y="${sy(v) + 4}" text-anchor="end" fill="#8b949c" font-size="11">${money(Math.round(v))}</text>
     <line x1="${P.l}" x2="${W - P.r}" y1="${sy(v)}" y2="${sy(v)}" stroke="#2b3035"/>`).join('');
  const lines = series.map(({ name, color, points }) => {
    let d = `M${sx(points[0].t)},${sy(points[0].price)}`;
    for (let i = 1; i < points.length; i++) d += ` H${sx(points[i].t)} V${sy(points[i].price)}`;
    d += ` H${sx(now)}`;
    const dots = points.map((p) =>
      `<circle cx="${sx(p.t)}" cy="${sy(p.price)}" r="3.5" fill="${color}"><title>${name} ${fmt(p.t)}: ${money(Math.round(p.price))}${p.discount ? ` (-${p.discount}%)` : ''}</title></circle>`).join('');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
  }).join('');
  const legend = series.length > 1
    ? '<div class="legend"><span><i class="lx"></i>Xbox</span><span><i class="ls"></i>Steam (convertido al cambio de hoy)</span></div>'
    : '';
  return `${legend}
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historial de precio">
      ${ticks}${lines}
      <text x="${P.l}" y="${H - 6}" fill="#8b949c" font-size="11">${fmt(x0)}</text>
      <text x="${W - P.r}" y="${H - 6}" fill="#8b949c" font-size="11" text-anchor="end">hoy</text>
    </svg>`;
}

// Tabla Xbox vs Steam: cada fila es un dato, cada columna una tienda. La columna más barata se resalta.
function compareTable(g, xboxUrl) {
  const s = g.steam;
  const priced = s.status === 'priced';
  const inUsd = priced && s.priceLocal !== null && s.currency !== state.data.currency;
  const steamCell = (value) => (value === null || value === undefined ? '—'
    : `${steamPrice(s, value)}${inUsd ? `<small>${escapeHtml(s.currency)} ${value}</small>` : ''}`);
  const steamUrl = s.appid ? escapeHtml(`https://store.steampowered.com/app/${encodeURIComponent(s.appid)}`) : null;
  const head = (name, cls, best) => `<th class="${cls} ${best ? 'best' : ''}">${name}${best ? '<span class="pill">Más barato</span>' : ''}</th>`;
  const rows = [
    ['Precio actual', `<strong>${money(g.price)}</strong>`, priced ? `<strong>${steamCell(s.price)}</strong>` : escapeHtml(steamStatusText(s))],
    ['Precio original', money(g.msrp), priced ? steamCell(s.msrp) : '—'],
    ['Descuento', g.discount ? `<span class="off xbox">-${g.discount}%</span>` : 'Sin oferta', priced ? (s.discount ? `<span class="off steam">-${s.discount}%</span>` : 'Sin oferta') : '—'],
    ['Mínimo registrado', money(g.lowestPrice), priced ? steamCell(s.lowestPrice) : '—'],
    ['Oferta hasta', g.saleEnd ? new Date(g.saleEnd).toLocaleDateString(state.locale) : '—', '—'],
  ];
  const steamName = s.appid ? (s.itemName || s.name) : null;
  const report = reportUrl(g);
  const matchedWith = steamName
    ? `<p class="matched">Comparado con <strong>${escapeHtml(steamName)}</strong> en Steam${s.company ? ` · ${escapeHtml(s.company)}` : ''}${s.edition === 'standard_only' ? ' <span class="pill warn">Otra edición</span>' : ''}</p>`
    : '';
  const footer = report
    ? `<p class="report"><a href="${escapeHtml(report)}" target="_blank" rel="noopener">¿La comparación está mal o el juego sí está en Steam? Reportalo</a></p>`
    : '';
  return `${matchedWith}
    <table class="compare-table">
      <thead><tr><th></th>${head('Xbox', 'xbox', s.cheaper === 'xbox')}${head('Steam', 'steam', s.cheaper === 'steam')}</tr></thead>
      <tbody>${rows.map(([label, x, st]) => `<tr><th>${label}</th><td class="xbox ${s.cheaper === 'xbox' ? 'best' : ''}">${x}</td><td class="steam ${s.cheaper === 'steam' ? 'best' : ''}">${st}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th></th>
        <td><a class="btn" href="${xboxUrl}" target="_blank" rel="noopener">Ver en Xbox</a></td>
        <td>${steamUrl ? `<a class="btn steam" href="${steamUrl}" target="_blank" rel="noopener">Ver en Steam</a>` : ''}</td>
      </tr></tfoot>
    </table>${footer}`;
}

// Resumen en una frase: dónde está la oferta y dónde conviene
function verdictText(g) {
  const s = g.steam;
  const sale = [g.discount > 0 && `en oferta en Xbox (-${g.discount}%)`, s.discount > 0 && `en oferta en Steam (-${s.discount}%)`].filter(Boolean);
  const saleText = sale.length ? `Está ${sale.join(' y ')}.` : 'Sin ofertas en ninguna de las dos tiendas.';
  if (s.status !== 'priced') return `${saleText} En Steam: ${steamStatusText(s)}.`;
  if (s.edition === 'standard_only') {
    return `${saleText} Steam no vende esta edición: la estándar cuesta ${steamPrice(s)} (solo como referencia, no es comparable).`;
  }
  if (!s.cheaper) return saleText;
  if (s.cheaper === 'equal') return `${saleText} Cuesta prácticamente lo mismo en las dos.`;
  const diff = Math.abs(g.price - s.priceLocal);
  return `${saleText} <strong class="verdict ${s.cheaper}">${VERDICT[s.cheaper]} ${s.diffPct}% menos</strong> (${money(Math.round(diff))} de diferencia).`;
}

function openDetail(id) {
  const g = state.byId.get(id);
  if (!g) return;
  const xboxUrl = escapeHtml(`https://www.xbox.com/${encodeURIComponent(state.locale)}/games/store/x/${encodeURIComponent(id)}`);
  const on = state.following.has(id);
  const stat = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  $('detailBody').innerHTML = `
    <button class="close" data-close>✕</button>
    <img src="${imageUrl(g.image, 360)}" alt="">
    <div>
      <h2>${escapeHtml(g.title)}</h2>
      <div class="meta">${escapeHtml(g.publisher)} · ${escapeHtml(g.platforms.map((p) => PLATFORM_NAMES[p] || p).join(', '))}</div>
      <div class="meta">${escapeHtml(g.categories.join(', '))}</div>
      <p class="summary">${verdictText(g)}</p>
      <div class="stats">
        ${g.previousPrice !== null ? stat('Antes en Xbox', money(g.previousPrice)) : ''}
        ${g.ranks.popular ? stat('Ranking popular', `#${g.ranks.popular}`) : ''}
        ${g.rating ? stat('Valoración', `${g.rating.toFixed(1)} ★ (${g.ratingCount})`) : ''}
        ${g.gamePass ? stat('Game Pass', 'Incluido') : ''}
      </div>
      <button class="btn ghost" data-star="${escapeHtml(id)}">${on ? '★ Siguiendo' : '☆ Seguir'}</button>
    </div>
    <div class="compare">
      ${compareTable(g, xboxUrl)}
      ${state.data.fx && g.steam.status === 'priced' ? `<p class="note">Steam cobra en ${escapeHtml(state.data.fx.from)}; convertido con ${escapeHtml(state.data.fx.source)} (${escapeHtml(state.data.fx.from)} 1 = ${money(state.data.fx.rate)}). Las dos tiendas suman los mismos impuestos al pagar (IVA + IIBB), por eso se comparan los precios base.</p>` : ''}
    </div>
    <div class="chart">
      <h3>Historial de precio</h3>
      ${historyChart(g)}
    </div>`;
  $('detail').showModal();
}

function toggleFollow(id) {
  if (state.following.has(id)) state.following.delete(id); else state.following.add(id);
  store.set('following', [...state.following]);
  document.querySelectorAll(`[data-star="${CSS.escape(id)}"]`).forEach((b) => {
    const on = state.following.has(id);
    b.classList.toggle('on', on);
    b.textContent = b.classList.contains('star') ? (on ? '★' : '☆') : (on ? '★ Siguiendo' : '☆ Seguir');
  });
  if (state.view === 'following') render();
}

// ---------- Eventos ----------

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  state.view = btn.dataset.view;
  $('sort').value = '';
  render();
});

let searchTimer;
$('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 150); });
for (const id of ['platform', 'genre', 'gamePass', 'steam', 'sort']) $(id).addEventListener('change', () => render());
$('minDiscount').addEventListener('input', (e) => { $('minDiscountLabel').textContent = `${e.target.value}%`; });
$('minDiscount').addEventListener('change', () => render());

$('locale').addEventListener('change', async (e) => {
  state.locale = e.target.value;
  store.set('locale', state.locale);
  await loadData();
  render();
});

$('more').addEventListener('click', () => { state.page++; render({ append: true }); });

document.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) { e.stopPropagation(); toggleFollow(star.dataset.star); return; }
  if (e.target.closest('[data-close]')) { $('detail').close(); return; }
  const c = e.target.closest('.card');
  if (c) openDetail(c.dataset.id);
});
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });

// ---------- Modo servidor (solo con `npm start`): botón de actualizar ----------

async function serverStatus() {
  try {
    return await getJson(`api/status?locale=${encodeURIComponent(state.locale)}`);
  } catch {
    return null; // sitio estático (GitHub Pages): no hay API
  }
}

let pollTimer;
async function pollWhileScraping() {
  clearTimeout(pollTimer);
  const status = await serverStatus();
  if (status?.scraping) {
    renderStatus(status);
    pollTimer = setTimeout(pollWhileScraping, 3000);
  } else {
    await loadData();
    renderStatus(status);
    render();
  }
}

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try {
    await getJson('api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: state.locale }) });
  } catch (err) {
    alert(err.message);
  }
  pollWhileScraping();
});

// ---------- Inicio ----------

state.meta = await getJson('data/meta.json');
if (!Object.keys(state.meta.locales).length) {
  $('status').textContent = 'Todavía no hay precios: la primera actualización está en camino.';
  throw new Error('Sin datos');
}
if (!state.meta.locales[state.locale]) state.locale = state.meta.defaultLocale;
$('locale').innerHTML = Object.entries(state.meta.locales)
  .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join('');
$('locale').value = state.locale;

await loadData();
render();
const status = await serverStatus();
state.server = Boolean(status);
renderStatus(status);
if (status?.scraping) pollWhileScraping();
