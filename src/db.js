import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.NEXOMOCHIS_DB_PATH || join(__dirname, '..', 'data', 'mymochis.db');

if (!existsSync(dirname(DB_PATH))) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  business_name TEXT NOT NULL DEFAULT 'MyMochis',
  tagline TEXT DEFAULT 'Mochis artesanales hechos a mano en Neiva',
  description TEXT,
  whatsapp_number TEXT DEFAULT '573000000000',
  instagram_handle TEXT DEFAULT '@mymochis.neiva',
  instagram_url TEXT DEFAULT 'https://instagram.com/mymochis.neiva',
  facebook_url TEXT,
  tiktok_handle TEXT,
  pickup_address TEXT DEFAULT 'Cocina oculta en Neiva',
  pickup_schedule TEXT DEFAULT 'Mar–Sáb · 3pm a 7pm',
  hero_image_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flavors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 8000,
  available INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  units INTEGER NOT NULL,
  price INTEGER NOT NULL,
  description TEXT,
  compare_at_price INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  pickup_day TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '{}',
  combos_json TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'web',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_pickup_day ON orders(pickup_day);

CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('percent','fixed','bxgy')),
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  min_purchase INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK(platform IN ('instagram','facebook','tiktok','whatsapp')),
  content TEXT NOT NULL,
  image_url TEXT,
  scheduled_for TEXT,
  posted_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','posted','failed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SEED_FLAVORS = [
  { id: 'fresas-crema', name: 'Fresas con crema', description: 'Fresa fresca del Huila, crema batida y un toque de vainilla', price: 8000, color: '#e88a9e', sort_order: 0 },
  { id: 'chokis-cream', name: 'Chokis & cream', description: 'Trozos de galleta Chokis con crema dulce — nuestro hit', price: 8000, color: '#b8954e', sort_order: 1 },
  { id: 'blueberry', name: 'Blueberry', description: 'Arándano entero, crema suave y un guiño a limón', price: 8000, color: '#7a6db8', sort_order: 2 },
  { id: 'durazno-caramelizado', name: 'Durazno caramelizado', description: 'Rodaja de durazno con caramelo dorado y notas de canela', price: 8000, color: '#d88450', sort_order: 3 },
  { id: 'crema-pastelera', name: 'Crema pastelera', description: 'La clásica: vainilla, yema y un corazón cremoso', price: 8000, color: '#c4a866', sort_order: 4 }
];

const SEED_COMBOS = [
  { name: 'Combo 4', units: 4, price: 28000, description: 'Ideal para probar varios sabores en una tarde.', compare_at_price: 32000, featured: 0, sort_order: 0 },
  { name: 'Combo 6', units: 6, price: 39000, description: 'El favorito para compartir en familia o con amigos.', compare_at_price: 48000, featured: 1, sort_order: 1 },
  { name: 'Caja sorpresa 12', units: 12, price: 75000, description: 'Una caja surtida con todos los sabores y nuestras pruebas nuevas.', compare_at_price: 96000, featured: 0, sort_order: 2 }
];

export function init() {
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO config (id) VALUES (1)').run();

  const flavorCount = db.prepare('SELECT COUNT(*) as n FROM flavors').get().n;
  if (flavorCount === 0) {
    const stmt = db.prepare('INSERT INTO flavors (id, name, description, price, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of SEED_FLAVORS) stmt.run(f.id, f.name, f.description, f.price, f.color, f.sort_order);
  }

  const comboCount = db.prepare('SELECT COUNT(*) as n FROM combos').get().n;
  if (comboCount === 0) {
    const stmt = db.prepare('INSERT INTO combos (name, units, price, description, compare_at_price, featured, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of SEED_COMBOS) stmt.run(c.name, c.units, c.price, c.description, c.compare_at_price, c.featured, c.sort_order);
  }
}

export function close() {
  db.close();
}