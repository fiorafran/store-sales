// Uso: npm run scrape -- es-AR
import { scrape } from './scraper.js';
import { DEFAULT_LOCALE } from './config.js';

await scrape(process.argv[2] || DEFAULT_LOCALE);
