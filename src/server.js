// Modo servidor (local o en un hosting con proceso permanente): sirve la web, los datos,
// actualiza precios cada REFRESH_HOURS y corre el bot de Discord. Para hosting gratis ver build.js.
import express from 'express';
import { db } from './db.js';
import { scrape, isScraping } from './scraper.js';
import { cached, clearCache } from './cache.js';
import { rateLimit } from './rate-limit.js';
import { exportMeta, exportLocale } from './export.js';
import { PORT, LOCALES, SCRAPE_LOCALES, REFRESH_HOURS, REFRESH_COOLDOWN_MIN, TRUST_PROXY } from './config.js';
import { startDiscordBot } from './discord.js';

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://store-images.s-microsoft.com; "
      + "style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public', { maxAge: '10m' }));
app.use(['/api', '/data'], rateLimit({ windowMs: 60_000, max: 120 }));

// Los mismos JSON que genera el build estático. Se arman una vez y se guardan en memoria
// hasta la próxima actualización de precios (único momento en que cambian).
app.get('/data/meta.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60').json(cached('meta', exportMeta));
});

app.get('/data/:locale.json', (req, res) => {
  const { locale } = req.params;
  if (!LOCALES[locale]) return res.status(404).json({ error: 'No encontrado' });
  res.set('Cache-Control', 'public, max-age=60').json(cached(`locale:${locale}`, () => exportLocale(locale)));
});

// Próximo momento en que se permite una actualización manual (null = ya se puede)
function nextManualRefresh(locale) {
  const hasData = db.prepare('SELECT 1 FROM scrape_runs WHERE locale = ? AND error IS NULL LIMIT 1').get(locale);
  if (!hasData) return null;
  const last = db.prepare('SELECT MAX(finished_at) AS t FROM scrape_runs WHERE error IS NULL').get().t;
  const next = new Date(last).getTime() + REFRESH_COOLDOWN_MIN * 60e3;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

app.get('/api/status', (req, res) => {
  const locale = LOCALES[req.query.locale] ? req.query.locale : SCRAPE_LOCALES[0];
  res.set('Cache-Control', 'no-store').json({ scraping: isScraping(), nextManualRefresh: nextManualRefresh(locale) });
});

app.post('/api/refresh', rateLimit({ windowMs: 3600e3, max: 10 }), (req, res) => {
  const locale = req.body?.locale;
  if (!LOCALES[locale]) return res.status(400).json({ error: 'Mercado inválido' });
  if (isScraping()) return res.status(409).json({ error: 'Ya hay una actualización en curso' });
  const next = nextManualRefresh(locale);
  if (next) {
    res.set('Retry-After', String(Math.ceil((new Date(next) - Date.now()) / 1000)));
    return res.status(429).json({ error: 'Los precios se actualizaron hace poco. Probá más tarde.', nextManualRefresh: next });
  }
  runScrape(locale);
  res.status(202).json({ started: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(['/api', '/data'], (req, res) => res.status(404).json({ error: 'No encontrado' }));

// Nunca mostrar stack traces al visitante
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status === 400 ? 'Pedido inválido' : 'Error interno' });
});

// Toda actualización pasa por acá: al terminar (bien o mal) se vacía la caché
async function runScrape(locale) {
  try {
    await scrape(locale);
  } catch (err) {
    console.error(`Error al actualizar ${locale}:`, err.message);
  } finally {
    clearCache();
  }
}

async function refreshAll() {
  for (const locale of SCRAPE_LOCALES) await runScrape(locale);
}

startDiscordBot().catch((err) => console.error('[discord] No se pudo iniciar el bot:', err.message));

app.listen(PORT, () => {
  console.log(`Store Sales en http://localhost:${PORT}`);
  const last = db.prepare('SELECT MAX(started_at) AS t FROM scrape_runs WHERE error IS NULL').get().t;
  const stale = !last || Date.now() - new Date(last).getTime() > REFRESH_HOURS * 3600e3;
  if (stale) refreshAll();
  setInterval(refreshAll, REFRESH_HOURS * 3600e3);
});
