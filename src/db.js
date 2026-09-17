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

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  instructions TEXT,
  qr_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payout_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON DELETE CASCADE,
  holder_name TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS release_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_date TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','completed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_release_windows_date ON release_windows(release_date);
CREATE INDEX IF NOT EXISTS idx_release_windows_status ON release_windows(status);

CREATE TABLE IF NOT EXISTS release_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_id INTEGER NOT NULL REFERENCES release_windows(id) ON DELETE CASCADE,
  flavor_id TEXT NOT NULL REFERENCES flavors(id) ON DELETE CASCADE,
  units_available INTEGER NOT NULL DEFAULT 0,
  units_sold INTEGER NOT NULL DEFAULT 0,
  UNIQUE(window_id, flavor_id)
);

CREATE TABLE IF NOT EXISTS delivery_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('pickup','delivery','both')) DEFAULT 'pickup',
  cutoff_offset_hours INTEGER NOT NULL DEFAULT 8,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_delivery_schedule_dow ON delivery_schedule(day_of_week, active);

CREATE TABLE IF NOT EXISTS geocoded_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_address TEXT UNIQUE NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  display_name TEXT,
  lookup_count INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const SEED_FLAVORS = [
  { id: 'fresas-crema', name: 'Fresas con crema', description: 'Fresa fresca del Huila, crema batida y un toque de vainilla', price: 8000, color: '#e88a9e', category: 'clasicos', sort_order: 0 },
  { id: 'chokis-cream', name: 'Chokis & cream', description: 'Trozos de galleta Chokis con crema dulce — nuestro hit', price: 8000, color: '#b8954e', category: 'premium', sort_order: 1 },
  { id: 'blueberry', name: 'Blueberry', description: 'Arándano entero, crema suave y un guiño a limón', price: 8000, color: '#7a6db8', category: 'frutales', sort_order: 2 },
  { id: 'durazno-caramelizado', name: 'Durazno caramelizado', description: 'Rodaja de durazno con caramelo dorado y notas de canela', price: 8000, color: '#d88450', category: 'temporada', sort_order: 3 },
  { id: 'crema-pastelera', name: 'Crema pastelera', description: 'La clásica: vainilla, yema y un corazón cremoso', price: 8000, color: '#c4a866', category: 'clasicos', sort_order: 4 }
];

const SEED_COMBOS = [
  { name: 'Combo 4', units: 4, price: 28000, description: 'Ideal para probar varios sabores en una tarde.', compare_at_price: 32000, featured: 0, sort_order: 0 },
  { name: 'Combo 6', units: 6, price: 39000, description: 'El favorito para compartir en familia o con amigos.', compare_at_price: 48000, featured: 1, sort_order: 1 },
  { name: 'Caja sorpresa 12', units: 12, price: 75000, description: 'Una caja surtida con todos los sabores y nuestras pruebas nuevas.', compare_at_price: 96000, featured: 0, sort_order: 2 }
];

const SEED_CATEGORIES = [
  { name: 'Clásicos',    slug: 'clasicos',   sort_order: 0 },
  { name: 'Frutales',    slug: 'frutales',   sort_order: 1 },
  { name: 'Premium',     slug: 'premium',    sort_order: 2 },
  { name: 'De temporada', slug: 'temporada', sort_order: 3 }
];

const SEED_PAYMENT_METHODS = [
  { code: 'nequi',       label: 'Nequi',                  instructions: 'Transfiere al número y envía el comprobante por WhatsApp.', sort_order: 0 },
  { code: 'daviplata',   label: 'Daviplata',              instructions: 'Transfiere al número y envía el comprobante por WhatsApp.', sort_order: 1 },
  { code: 'bancolombia', label: 'Bancolombia · Ahorros',  instructions: 'Consigna a la cuenta de ahorros y envía el comprobante.',   sort_order: 2 },
  { code: 'mercadopago', label: 'MercadoPago · link',     instructions: 'Te enviamos un link de pago por WhatsApp para confirmar.',  sort_order: 3 },
  { code: 'efectivo',    label: 'Efectivo al recibir',    instructions: 'Pagás cuando recogés o te entregamos el pedido.',           sort_order: 4 }
];

const SEED_DELIVERY_SCHEDULE = [
  { day_of_week: 1, start_time: '15:00', end_time: '19:00', mode: 'both',     cutoff_offset_hours: 8,  sort_order: 0, notes: 'Lunes · pickup + delivery' },
  { day_of_week: 2, start_time: '15:00', end_time: '19:00', mode: 'both',     cutoff_offset_hours: 8,  sort_order: 1, notes: 'Martes · pickup + delivery' },
  { day_of_week: 3, start_time: '15:00', end_time: '19:00', mode: 'both',     cutoff_offset_hours: 8,  sort_order: 2, notes: 'Miércoles · pickup + delivery' },
  { day_of_week: 4, start_time: '15:00', end_time: '19:00', mode: 'both',     cutoff_offset_hours: 8,  sort_order: 3, notes: 'Jueves · pickup + delivery' },
  { day_of_week: 5, start_time: '15:00', end_time: '19:00', mode: 'both',     cutoff_offset_hours: 8,  sort_order: 4, notes: 'Viernes · pickup + delivery' },
  { day_of_week: 6, start_time: '12:00', end_time: '17:00', mode: 'pickup',   cutoff_offset_hours: 12, sort_order: 5, notes: 'Sábado · solo pickup' }
];

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function init() {
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO config (id) VALUES (1)').run();

  ensureColumn('config',  'delivery_immediate_enabled',        'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('config',  'delivery_immediate_fee_cents',      'INTEGER NOT NULL DEFAULT 5000');
  ensureColumn('config',  'delivery_immediate_radius_km',      'INTEGER NOT NULL DEFAULT 5');
  ensureColumn('config',  'delivery_immediate_min_order_cents','INTEGER NOT NULL DEFAULT 20000');
  ensureColumn('config',  'delivery_immediate_eta_minutes',    'INTEGER NOT NULL DEFAULT 45');
  ensureColumn('config',  'delivery_zone_label',               "TEXT NOT NULL DEFAULT 'Neiva urbana'");
  ensureColumn('config',  'delivery_zone_center_lat',          'REAL');
  ensureColumn('config',  'delivery_zone_center_lng',          'REAL');
  ensureColumn('config',  'delivery_default_cutoff_hours',     'INTEGER NOT NULL DEFAULT 8');

  ensureColumn('orders',  'delivery_mode',         "TEXT CHECK(delivery_mode IN ('scheduled','immediate')) DEFAULT 'scheduled'");
  ensureColumn('orders',  'delivery_provider',     "TEXT NOT NULL DEFAULT 'own'");
  ensureColumn('orders',  'delivery_address',      'TEXT');
  ensureColumn('orders',  'delivery_lat',          'REAL');
  ensureColumn('orders',  'delivery_lng',          'REAL');
  ensureColumn('orders',  'delivery_distance_km',  'REAL');
  ensureColumn('orders',  'delivery_fee_cents',    'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('orders',  'payment_method_id',     'INTEGER REFERENCES payment_methods(id)');

  ensureColumn('flavors', 'category_id', 'INTEGER REFERENCES categories(id)');

  const catCount = db.prepare('SELECT COUNT(*) as n FROM categories').get().n;
  if (catCount === 0) {
    const stmt = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
    for (const c of SEED_CATEGORIES) stmt.run(c.name, c.slug, c.sort_order);
  }

  const catIds = db.prepare('SELECT id, slug FROM categories').all();
  const catMap = Object.fromEntries(catIds.map(c => [c.slug, c.id]));

  const flavorCount = db.prepare('SELECT COUNT(*) as n FROM flavors').get().n;
  if (flavorCount === 0) {
    const stmt = db.prepare('INSERT INTO flavors (id, name, description, price, color, sort_order, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of SEED_FLAVORS) stmt.run(f.id, f.name, f.description, f.price, f.color, f.sort_order, catMap[f.category] || null);
  }

  const comboCount = db.prepare('SELECT COUNT(*) as n FROM combos').get().n;
  if (comboCount === 0) {
    const stmt = db.prepare('INSERT INTO combos (name, units, price, description, compare_at_price, featured, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const c of SEED_COMBOS) stmt.run(c.name, c.units, c.price, c.description, c.compare_at_price, c.featured, c.sort_order);
  }

  const pmCount = db.prepare('SELECT COUNT(*) as n FROM payment_methods').get().n;
  if (pmCount === 0) {
    const stmt = db.prepare('INSERT INTO payment_methods (code, label, instructions, sort_order) VALUES (?, ?, ?, ?)');
    for (const p of SEED_PAYMENT_METHODS) stmt.run(p.code, p.label, p.instructions, p.sort_order);
  }

  const dsCount = db.prepare('SELECT COUNT(*) as n FROM delivery_schedule').get().n;
  if (dsCount === 0) {
    const stmt = db.prepare('INSERT INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const d of SEED_DELIVERY_SCHEDULE) stmt.run(d.day_of_week, d.start_time, d.end_time, d.mode, d.cutoff_offset_hours, d.sort_order, d.notes);
  }
}

export function close() {
  db.close();
}