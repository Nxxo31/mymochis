import { hashPassword } from './auth.js';

export function createDb(d1) {
  return {
    prepare(sql) {
      const stmt = d1.prepare(sql);
      return {
        async run(...params) {
          const r = await stmt.bind(...params).run();
          return {
            changes: r.meta?.changes ?? 0,
            lastInsertRowid: r.meta?.last_row_id ?? null,
            raw: r,
          };
        },
        get(...params) { return stmt.bind(...params).first(); },
        async all(...params) {
          const r = await stmt.bind(...params).all();
          return r.results || [];
        },
      };
    },
    exec(sql) { return d1.exec(sql); },
    batch(statements) { return d1.batch(statements); },
    prepareRaw(sql) { return d1.prepare(sql); },
  };
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  business_name TEXT NOT NULL DEFAULT 'MyMochis',
  tagline TEXT DEFAULT 'Mochis artesanales hechos a mano en Neiva',
  description TEXT,
  whatsapp_number TEXT DEFAULT '573000000000',
  instagram_handle TEXT DEFAULT '@my.mochiss',
  instagram_url TEXT DEFAULT 'https://instagram.com/my.mochiss/',
  facebook_url TEXT,
  tiktok_handle TEXT DEFAULT '@my.mochiss',
  pickup_address TEXT DEFAULT 'Cocina oculta en Neiva',
  pickup_schedule TEXT DEFAULT 'Mar-Sab 3pm a 7pm',
  hero_image_url TEXT,
  delivery_immediate_enabled INTEGER NOT NULL DEFAULT 0,
  delivery_immediate_fee_cents INTEGER NOT NULL DEFAULT 5000,
  delivery_immediate_radius_km INTEGER NOT NULL DEFAULT 5,
  delivery_immediate_min_order_cents INTEGER NOT NULL DEFAULT 20000,
  delivery_immediate_eta_minutes INTEGER NOT NULL DEFAULT 45,
  delivery_zone_label TEXT NOT NULL DEFAULT 'Neiva urbana',
  delivery_zone_center_lat REAL,
  delivery_zone_center_lng REAL,
  delivery_default_cutoff_hours INTEGER NOT NULL DEFAULT 8,
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
  category_id INTEGER REFERENCES categories(id),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, units)
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
  payment_method TEXT,
  delivery_mode TEXT CHECK(delivery_mode IN ('scheduled','immediate')) DEFAULT 'scheduled',
  delivery_provider TEXT NOT NULL DEFAULT 'own',
  delivery_address TEXT,
  delivery_lat REAL,
  delivery_lng REAL,
  delivery_distance_km REAL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  payment_method_id INTEGER REFERENCES payment_methods(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_pickup_day ON orders(pickup_day);

CREATE TABLE IF NOT EXISTS order_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_order_recipients_active ON order_recipients(active, sort_order);
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
CREATE TABLE IF NOT EXISTS uploads (
  filename TEXT PRIMARY KEY,
  originalname TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category TEXT,
  alt_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_uploads_category ON uploads(category, uploaded_at DESC);
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

const SEED_SQL = `
INSERT OR IGNORE INTO config (id) VALUES (1);
INSERT OR IGNORE INTO categories (name, slug, sort_order) VALUES
  ('Clasicos', 'clasicos', 0),
  ('Frutales', 'frutales', 1),
  ('Premium', 'premium', 2),
  ('De temporada', 'temporada', 3);
INSERT OR IGNORE INTO flavors (id, name, description, price, color, sort_order, category_id) VALUES
  ('fresas-crema', 'Fresas con crema', 'Fresa fresca del Huila, crema batida y un toque de vainilla', 8000, '#e88a9e', 0, (SELECT id FROM categories WHERE slug='clasicos')),
  ('chokis-cream', 'Chokis & cream', 'Trozos de galleta Chokis con crema dulce - nuestro hit', 8000, '#b8954e', 1, (SELECT id FROM categories WHERE slug='premium')),
  ('blueberry', 'Blueberry', 'Arandano entero, crema suave y un guiño a limon', 8000, '#7a6db8', 2, (SELECT id FROM categories WHERE slug='frutales')),
  ('durazno-caramelizado', 'Durazno caramelizado', 'Rodaja de durazno con caramelo dorado y notas de canela', 8000, '#d88450', 3, (SELECT id FROM categories WHERE slug='temporada')),
  ('crema-pastelera', 'Crema pastelera', 'La clasica: vainilla, yema y un corazon cremoso', 8000, '#c4a866', 4, (SELECT id FROM categories WHERE slug='clasicos'));
-- combos: idempotent via INSERT OR IGNORE (UNIQUE(name,units) on the table)
INSERT OR IGNORE INTO combos (name, units, price, description, compare_at_price, featured, sort_order) VALUES
  ('Combo 4', 4, 28000, 'Ideal para probar varios sabores en una tarde.', 32000, 0, 0),
  ('Combo 6', 6, 39000, 'El favorito para compartir en familia o con amigos.', 48000, 1, 1),
  ('Caja sorpresa 12', 12, 75000, 'Una caja surtida con todos los sabores y nuestras pruebas nuevas.', 96000, 0, 2);
INSERT OR IGNORE INTO payment_methods (code, label, instructions, sort_order) VALUES
  ('nequi', 'Nequi', 'Transfiere al numero y envia el comprobante por WhatsApp.', 0),
  ('daviplata', 'Daviplata', 'Transfiere al numero y envia el comprobante por WhatsApp.', 1),
  ('bancolombia', 'Bancolombia - Ahorros', 'Consigna a la cuenta de ahorros y envia el comprobante.', 2),
  ('mercadopago', 'MercadoPago - link', 'Te enviamos un link de pago por WhatsApp para confirmar.', 3),
  ('efectivo', 'Efectivo al recibir', 'Pagas cuando recoges o te entregamos el pedido.', 4);
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 1,'15:00','19:00','both',8,0,'Lunes - pickup + delivery'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=1 AND start_time='15:00');
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 2,'15:00','19:00','both',8,1,'Martes - pickup + delivery'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=2 AND start_time='15:00');
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 3,'15:00','19:00','both',8,2,'Miercoles - pickup + delivery'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=3 AND start_time='15:00');
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 4,'15:00','19:00','both',8,3,'Jueves - pickup + delivery'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=4 AND start_time='15:00');
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 5,'15:00','19:00','both',8,4,'Viernes - pickup + delivery'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=5 AND start_time='15:00');
INSERT OR IGNORE INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, sort_order, notes)
SELECT 6,'12:00','17:00','pickup',12,5,'Sabado - solo pickup'
WHERE NOT EXISTS (SELECT 1 FROM delivery_schedule WHERE day_of_week=6 AND start_time='12:00');
`;

let initPromise = null;

export function ensureInit(env) {
  if (!initPromise) initPromise = doInit(env).catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

function splitStatements(sql) {
  // Strip SQL line comments (-- ...) so they don't leak into the next statement
  const stripped = sql.replace(/^\s*--[^\n]*$/gm, '').replace(/--[^\n]*\n/g, '\n');
  return stripped
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';');
}

async function execScript(db, sql) {
  const stmts = splitStatements(sql);
  console.log('[execScript] running', stmts.length, 'statements');
  for (let i = 0; i < stmts.length; i++) {
    let stmt = stmts[i].replace(/;\s*$/, '').trim();
    if (stmt.length === 0) continue;
    // D1's exec() is line-based; collapse internal newlines to spaces
    stmt = stmt.replace(/\s+/g, ' ').trim();
    console.log('[execScript]', i, 'len=' + stmt.length, 'preview=' + stmt.slice(0, 60));
    try {
      await db.exec(stmt);
      console.log('[execScript] OK', i);
    } catch (e) {
      console.error('[execScript] FAIL', i, e?.message || e);
      throw e;
    }
  }
}

async function doInit(env) {
  const db = createDb(env.DB);
  await execScript(db, SCHEMA_SQL);
  await execScript(db, SEED_SQL);
  // 2026-10-17: demote global de admins eliminado (multi-admin soportado).
  // Multi-número: importar config.whatsapp_number como primer destinatario.
  try {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM order_recipients').get()).n;
    if (n === 0) {
      const cfg = await db.prepare('SELECT whatsapp_number FROM config WHERE id = 1').get();
      const digits = String(cfg?.whatsapp_number || '').replace(/\D/g, '');
      if (digits && digits !== '573000000000' && /^\d{8,15}$/.test(digits)) {
        await db.prepare('INSERT INTO order_recipients (label, phone, active, sort_order) VALUES (?, ?, 1, 0)').run('Admin principal', digits);
      }
    }
  } catch (e) {
    console.warn('[db] order_recipients seed skipped:', e?.message || e);
  }

  const adminEmail = env.ADMIN_EMAIL;
  const adminPassword = env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && String(adminPassword).length >= 8) {
    const emailLower = String(adminEmail).toLowerCase().trim();
    const existing = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(emailLower);
    if (!existing) {
      const { salt, hash } = await hashPassword(String(adminPassword), env);
      try {
        await db.prepare(
          "INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, 'admin')"
        ).run(emailLower, hash, salt, 'Admin');
        console.log('[mymochis] admin seed creado:', emailLower);
      } catch (e) {
        if (!String(e?.message || e).includes('UNIQUE')) throw e;
      }
    } else {
      if (existing.role !== 'admin') {
        await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
      }
      if (env.ADMIN_PASSWORD_RESET === 'true') {
        const { salt, hash } = await hashPassword(String(adminPassword), env);
        await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, existing.id);
        console.log('[mymochis] admin password rotada via ADMIN_PASSWORD_RESET:', emailLower);
      }
    }
  }
}
