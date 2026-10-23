// Build para hosting estático gratis (GitHub Actions + GitHub Pages):
// actualiza precios, avisa por webhook de Discord y genera el sitio en site/.
// Uso: npm run build                 (actualiza y genera)
//      npm run build -- --no-scrape  (solo genera con los datos que ya hay)
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { db } from './db.js';
import { scrape } from './scraper.js';
import { updateSteam } from './steam.js';
import { exportMeta, exportLocale } from './export.js';
import { highlightMessages } from './discord.js';
import { SCRAPE_LOCALES, DISCORD } from './config.js';

const OUT = 'site';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

async function sendWebhook(message) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Store Sales', content: message.content, embeds: message.embeds.map((e) => e.toJSON()) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord webhook respondió ${res.status}`);
}

if (!process.argv.includes('--no-scrape')) {
  for (const locale of SCRAPE_LOCALES) {
    const { drops } = await scrape(locale);
    await updateSteam(locale);
    if (!WEBHOOK || locale !== DISCORD.locale) continue;
    for (const message of highlightMessages(locale, drops)) {
      try { await sendWebhook(message); } catch (err) { console.error('[webhook]', err.message); }
    }
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/data`, { recursive: true });
await cp('public', OUT, { recursive: true });
await writeFile(`${OUT}/.nojekyll`, ''); // GitHub Pages: servir los archivos tal cual
const meta = exportMeta();
await writeFile(`${OUT}/data/meta.json`, JSON.stringify(meta));
for (const locale of Object.keys(meta.locales)) {
  await writeFile(`${OUT}/data/${locale}.json`, JSON.stringify(exportLocale(locale)));
}
console.log(`Sitio generado en ${OUT}/ (${Object.keys(meta.locales).join(', ')})`);

// Vuelca el WAL al archivo principal: en CI se guarda solo store.db
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
