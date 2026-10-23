import { db } from './db.js';
import { DEFAULT_LOCALE, LOCALES, REFRESH_HOURS } from './config.js';

// Arma los datos que consume el frontend: un JSON por mercado con todos los juegos e historial.
// Lo usan tanto el servidor local como el build estático (GitHub Pages).

export function exportMeta() {
  const available = db.prepare('SELECT DISTINCT locale FROM prices').all().map((r) => r.locale);
  return {
    defaultLocale: available.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : available[0] ?? DEFAULT_LOCALE,
    locales: Object.fromEntries(Object.entries(LOCALES).filter(([k]) => available.includes(k))),
    refreshHours: REFRESH_HOURS,
  };
}

export function exportLocale(locale) {
  const lastRun = db.prepare(
    'SELECT finished_at, error FROM scrape_runs WHERE locale = ? ORDER BY started_at DESC LIMIT 1'
  ).get(locale);

  const ranks = new Map();
  for (const r of db.prepare('SELECT product_id, list, position FROM rankings WHERE locale = ?').all(locale)) {
    if (!ranks.has(r.product_id)) ranks.set(r.product_id, {});
    ranks.get(r.product_id)[r.list] = r.position;
  }

  const history = new Map();
  for (const h of db.prepare(
    'SELECT product_id, price, discount, recorded_at FROM price_history WHERE locale = ? ORDER BY recorded_at'
  ).all(locale)) {
    if (!history.has(h.product_id)) history.set(h.product_id, []);
    history.get(h.product_id).push([h.recorded_at, h.price, h.discount]);
  }

  const rows = db.prepare(`
    SELECT p.*, pr.currency, pr.price, pr.msrp, pr.discount, pr.sale_end, pr.previous_price, pr.lowest_price, pr.changed_at
    FROM prices pr JOIN products p ON p.id = pr.product_id WHERE pr.locale = ?
  `).all(locale);

  const games = rows.map((r) => {
    const h = history.get(r.id) || [];
    return {
      id: r.id,
      title: r.title,
      publisher: r.publisher,
      image: r.image,
      categories: JSON.parse(r.categories || '[]'),
      platforms: JSON.parse(r.platforms || '[]'),
      rating: r.rating,
      ratingCount: r.rating_count,
      releaseDate: r.release_date,
      gamePass: Boolean(r.game_pass),
      price: r.price,
      msrp: r.msrp,
      discount: r.discount,
      saleEnd: r.sale_end,
      previousPrice: r.previous_price,
      lowestPrice: r.lowest_price,
      changedAt: r.changed_at,
      ranks: ranks.get(r.id) || {},
      dropped: r.previous_price !== null && r.price < r.previous_price,
      // "Mínimo histórico" solo si alguna vez lo vimos más caro (con un único registro todo sería mínimo)
      isLowest: r.discount > 0 && r.price <= r.lowest_price && h.some(([, price]) => price > r.price),
      history: h,
    };
  });

  return {
    locale,
    currency: rows[0]?.currency ?? null,
    updatedAt: lastRun?.finished_at ?? null,
    lastError: lastRun?.error ?? null,
    games,
  };
}
