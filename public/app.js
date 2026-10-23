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
  const sort = SORTS[$('sort').value || view.sort];

  return state.data.games
    .filter((g) => view.filter(g)
      && (!q || g.title.toLowerCase().includes(q))
      && (!platform || g.platforms.includes(platform))
      && (!genre || g.categories.includes(genre))
      && (!gamePass || g.gamePass === (gamePass === '1'))
      && g.discount >= minDiscount)
    .sort((a, b) => sort(a, b) || a.title.localeCompare(b.title));
}

// ---------- Listado ----------

function card(g) {
  const badges = [];
  if (g.discount > 0) badges.push(`<span class="badge sale">-${g.discount}%</span>`);
  if (g.dropped) badges.push(`<span class="badge drop">↓ Bajó</span>`);
  if (g.isLowest) badges.push(`<span class="badge lowest">Mínimo histórico</span>`);
  if (g.gamePass) badges.push(`<span class="badge gp">Game Pass</span>`);
  const on = state.following.has(g.id);
  return `
    <article class="card" data-id="${escapeHtml(g.id)}">
      <div class="cover">
        ${g.image ? `<img loading="lazy" src="${imageUrl(g.image)}" alt="">` : ''}
        <div class="badges">${badges.join('')}</div>
        <button class="star ${on ? 'on' : ''}" data-star="${escapeHtml(g.id)}" title="${on ? 'Dejar de seguir' : 'Seguir este juego'}">${on ? '★' : '☆'}</button>
      </div>
      <div class="info">
        <div class="title">${escapeHtml(g.title)}</div>
        <div class="meta">${g.discount > 0 && g.saleEnd ? daysLeft(g.saleEnd) : escapeHtml(g.publisher)}</div>
        <div class="prices">
          <span class="price ${g.price === 0 ? 'free' : ''}">${money(g.price)}</span>
          ${g.msrp > g.price ? `<span class="old">${money(g.msrp)}</span>` : ''}
          ${!g.discount && g.dropped ? `<span class="old">${money(g.previousPrice)}</span>` : ''}
        </div>
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

function historyChart(g) {
  const history = g.history.map(([recorded_at, price, discount]) => ({ recorded_at, price, discount }));
  if (history.length < 2) {
    return '<p class="note">Todavía hay un solo registro de precio. El historial se arma con cada actualización (cada vez que cambia el precio se guarda un punto).</p>';
  }
  const W = 700, H = 180, P = { l: 70, r: 12, t: 12, b: 24 };
  const pts = [...history, { ...history.at(-1), recorded_at: new Date().toISOString() }];
  const xs = pts.map((h) => new Date(h.recorded_at).getTime());
  const ys = pts.map((h) => h.price);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const yMax = Math.max(g.msrp, ...ys) * 1.05 || 1;
  const sx = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const sy = (y) => P.t + (1 - y / yMax) * (H - P.t - P.b);
  // Escalonado: el precio se mantiene hasta el siguiente cambio
  let d = `M${sx(xs[0])},${sy(ys[0])}`;
  for (let i = 1; i < pts.length; i++) d += ` H${sx(xs[i])} V${sy(ys[i])}`;
  const ticks = [0, yMax / 2, yMax].map((v) =>
    `<text x="${P.l - 8}" y="${sy(v) + 4}" text-anchor="end" fill="#8b949c" font-size="11">${money(Math.round(v))}</text>
     <line x1="${P.l}" x2="${W - P.r}" y1="${sy(v)}" y2="${sy(v)}" stroke="#2b3035"/>`).join('');
  const fmt = (t) => new Date(t).toLocaleDateString(state.locale, { day: 'numeric', month: 'short' });
  const dots = history.map((h) =>
    `<circle cx="${sx(new Date(h.recorded_at).getTime())}" cy="${sy(h.price)}" r="3.5" fill="#2fbf3b"><title>${fmt(h.recorded_at)}: ${money(h.price)}${h.discount ? ` (-${h.discount}%)` : ''}</title></circle>`).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historial de precio">
      ${ticks}
      <path d="${d}" fill="none" stroke="#2fbf3b" stroke-width="2"/>
      ${dots}
      <text x="${P.l}" y="${H - 6}" fill="#8b949c" font-size="11">${fmt(x0)}</text>
      <text x="${W - P.r}" y="${H - 6}" fill="#8b949c" font-size="11" text-anchor="end">hoy</text>
    </svg>`;
}

function openDetail(id) {
  const g = state.byId.get(id);
  if (!g) return;
  const storeUrl = escapeHtml(`https://www.xbox.com/${encodeURIComponent(state.locale)}/games/store/x/${encodeURIComponent(id)}`);
  const on = state.following.has(id);
  const stat = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  $('detailBody').innerHTML = `
    <button class="close" data-close>✕</button>
    <img src="${imageUrl(g.image, 360)}" alt="">
    <div>
      <h2>${escapeHtml(g.title)}</h2>
      <div class="meta">${escapeHtml(g.publisher)} · ${escapeHtml(g.platforms.map((p) => PLATFORM_NAMES[p] || p).join(', '))}</div>
      <div class="meta">${escapeHtml(g.categories.join(', '))}</div>
      <div class="stats">
        ${stat('Precio actual', money(g.price))}
        ${stat('Precio original', money(g.msrp))}
        ${stat('Descuento', g.discount ? `-${g.discount}%` : '—')}
        ${stat('Mínimo registrado', money(g.lowestPrice))}
        ${g.previousPrice !== null ? stat('Precio anterior', money(g.previousPrice)) : ''}
        ${g.saleEnd ? stat('Oferta hasta', new Date(g.saleEnd).toLocaleDateString(state.locale)) : ''}
        ${g.ranks.popular ? stat('Ranking popular', `#${g.ranks.popular}`) : ''}
        ${g.rating ? stat('Valoración', `${g.rating.toFixed(1)} ★ (${g.ratingCount})`) : ''}
      </div>
      <div class="links">
        <a class="btn" href="${storeUrl}" target="_blank" rel="noopener">Ver en la tienda</a>
        <button class="btn ghost" data-star="${escapeHtml(id)}">${on ? '★ Siguiendo' : '☆ Seguir'}</button>
      </div>
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
for (const id of ['platform', 'genre', 'gamePass', 'sort']) $(id).addEventListener('change', () => render());
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
