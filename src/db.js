import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'store.db'));

// Migraciones de bases creadas con versiones anteriores
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (columns('products').length && !columns('products').includes('developer')) {
  db.exec('ALTER TABLE products ADD COLUMN developer TEXT');
}
// La primera versión de Steam emparejaba por juego (appid) y no por edición: se rehace de cero
if (columns('steam_prices').includes('appid')) {
  db.exec('DROP TABLE steam_matches; DROP TABLE steam_prices; DROP TABLE steam_history;');
}

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
    game_pass INTEGER DEFAULT 0,
    developer TEXT
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

  -- Juego de Steam equivalente a cada producto de Xbox (steam_appid NULL = no se encontró)
  CREATE TABLE IF NOT EXISTS steam_matches (
    product_id TEXT PRIMARY KEY,
    steam_appid INTEGER,
    steam_name TEXT,
    item_key TEXT,        -- opción de compra elegida en Steam: sub:123 (paquete) o bundle:456
    item_name TEXT,       -- ej. "Hogwarts Legacy: Edición Digital Deluxe"
    edition TEXT,         -- same (misma edición) | standard_only (Steam solo tiene la estándar)
    company TEXT,         -- editor/desarrollador en Steam con el que se verificó
    reason TEXT,          -- si no se emparejó: not_found | company
    method TEXT,          -- auto | manual
    checked_at TEXT
  );

  -- Precio actual en Steam por país (cc = código de país de Steam: ar, mx, us…)
  CREATE TABLE IF NOT EXISTS steam_prices (
    item_key TEXT,
    cc TEXT,
    currency TEXT,
    price REAL,
    msrp REAL,
    discount REAL,
    previous_price REAL,
    lowest_price REAL,
    changed_at TEXT,
    last_seen TEXT,
    PRIMARY KEY (item_key, cc)
  );

  CREATE TABLE IF NOT EXISTS steam_history (
    item_key TEXT,
    cc TEXT,
    price REAL,
    discount REAL,
    recorded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_steam_history ON steam_history (item_key, cc, recorded_at);

  -- Último tipo de cambio conocido (ej. USD→ARS), por si la API del dólar falla
  CREATE TABLE IF NOT EXISTS fx_rates (
    pair TEXT PRIMARY KEY,
    rate REAL,
    source TEXT,
    fetched_at TEXT
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
