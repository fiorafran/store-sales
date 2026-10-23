// Uso: npm run steam -- es-AR   (empareja con Steam y actualiza precios sin volver a pedir los de Xbox)
import { updateSteam } from './steam.js';
import { DEFAULT_LOCALE } from './config.js';

await updateSteam(process.argv[2] || DEFAULT_LOCALE);
