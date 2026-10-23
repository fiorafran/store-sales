import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'store.db'));

// Ejecuta fn dentro de una transacción (muchas escrituras juntas = un solo commit a disco)
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    title TEXT,
    publisher TEXT,
    image TEXT,
    categories TEXT,      -- JSON array
    platforms TEXT,       -- JSON array
    rating REAL,
    rating_count INTEGER,
    release_date TEXT,
    game_pass INTEGER DEFAULT 0
  );

  -- Estado actual del precio por mercado
  CREATE TABLE IF NOT EXISTS prices (
    product_id TEXT,
    locale TEXT,
    currency TEXT,
    price REAL,
    msrp REAL,
    discount REAL,
    sale_end TEXT,
    previous_price REAL,  -- precio anterior al último cambio
    changed_at TEXT,      -- fecha del último cambio de precio
    lowest_price REAL,
    first_seen TEXT,
    last_seen TEXT,
    PRIMARY KEY (product_id, locale)
  );

  -- Historial: solo se guarda una fila cuando el precio cambia
  CREATE TABLE IF NOT EXISTS price_history (
    product_id TEXT,
    locale TEXT,
    price REAL,
    msrp REAL,
    discount REAL,
    recorded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history ON price_history (product_id, locale, recorded_at);

  -- Posición del juego en cada lista (populares, más deseados, etc.)
  CREATE TABLE IF NOT EXISTS rankings (
    product_id TEXT,
    locale TEXT,
    list TEXT,
    position INTEGER,
    PRIMARY KEY (product_id, locale, list)
  );

  -- Juegos que sigue cada usuario de Discord (para avisarle cuando bajan)
  CREATE TABLE IF NOT EXISTS discord_follows (
    user_id TEXT,
    product_id TEXT,
    locale TEXT,
    created_at TEXT,
    PRIMARY KEY (user_id, product_id, locale)
  );

  CREATE TABLE IF NOT EXISTS scrape_runs (
    locale TEXT,
    started_at TEXT,
    finished_at TEXT,
    products INTEGER,
    price_changes INTEGER,
    error TEXT
  );
`);
