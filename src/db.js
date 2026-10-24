import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.NEXOMOCHIS_DB_PATH || join(__dirname, '..', 'data', 'mymochis.db');

if (!existsSync(dirname(DB_PATH))) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
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
  -- Stock real de combos (auditoria 2026-10-20, bug #6). Antes la columna
  -- available era un booleano y no habia forma de descontar unidades vendidas:
  -- los combos se podian vender infinitamente. -1 = stock ilimitado.
  units_available INTEGER NOT NULL DEFAULT -1,
  units_sold INTEGER NOT NULL DEFAULT 0,
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

-- ============================================================================
-- production (spec_id=30 G3) — insumos y costeo por lote.
-- Modelo de los software de costeo food: insumo × cantidad por lote → costo
-- del lote → costo por unidad (lote / unidades por lote). Con el margen
-- objetivo se sugiere precio de venta. Unidad: pesos COP como toda la app.
-- ============================================================================
CREATE TABLE IF NOT EXISTS production_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  qty_per_batch REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- ig_posts (spec_id=30 G4-01) — captura automática del feed de Instagram.
-- El admin conecta su token en Credenciales (vault, write-only) y el worker
-- ig-sync sincroniza solo: lo que publica en IG aparece en la galería de la
-- landing sin tocar código. Solo imágenes (los videos no van al grid).
-- ============================================================================
CREATE TABLE IF NOT EXISTS ig_posts (
  ig_id TEXT PRIMARY KEY,
  caption TEXT,
  media_url TEXT,
  permalink TEXT,
  media_type TEXT,
  posted_at TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- 0002_payments (Spec §22.5) — backend de pagos digitales
-- ============================================================================
CREATE TABLE IF NOT EXISTS payments (
  payment_id        TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL DEFAULT 'mymochis',
  order_id          TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'COP',
  state             TEXT NOT NULL DEFAULT 'INITIATED'
                       CHECK(state IN ('INITIATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_ACTION','UNRESOLVED','EXPIRED')),
  state_version     INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  customer_phone    TEXT,
  customer_email    TEXT,
  description       TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state, created_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  merchant_id         TEXT NOT NULL,
  operation           TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  payment_id          TEXT,
  response_status     INTEGER,
  response_body_json  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  PRIMARY KEY (merchant_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  attempt_id            TEXT PRIMARY KEY,
  payment_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,
  provider_idempotency_key TEXT NOT NULL,
  provider_reference     TEXT,
  attempt_state          TEXT NOT NULL
                            CHECK(attempt_state IN ('INITIATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_ACTION','UNRESOLVED','EXPIRED')),
  provider_response_json TEXT,
  error_code             TEXT,
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX IF NOT EXISTS idx_attempts_provider_ref ON payment_attempts(provider, provider_reference);

CREATE TABLE IF NOT EXISTS provider_events (
  event_id            TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  provider_event_id   TEXT,
  payload_json        TEXT NOT NULL,
  signature           TEXT,
  received_at         TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at        TEXT,
  process_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK(process_status IN ('pending','processed','failed','quarantined')),
  process_attempts    INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_pending ON provider_events(process_status, received_at);

-- ============================================================================
-- 2026-10-20 · Vault de credenciales de comercio (admin)
-- AES-256-GCM, write-only por API: el secreto NUNCA sale por HTTP.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchant_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  field TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  masked TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(provider, field)
);

CREATE TABLE IF NOT EXISTS credential_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  provider TEXT NOT NULL,
  field TEXT,
  actor TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cred_audit_created ON credential_audit(created_at DESC);


CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id        TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL,
  account         TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'COP',
  memo            TEXT,
  posted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_ledger_payment ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account, posted_at);

CREATE VIEW IF NOT EXISTS ledger_balances AS
SELECT account, currency, SUM(amount_minor) AS balance_minor
FROM ledger_entries
GROUP BY account, currency;

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id        TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  published_at    TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(published_at, created_at);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  provider          TEXT,
  status            TEXT NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','ok','mismatch','failed')),
  checks_total      INTEGER NOT NULL DEFAULT 0,
  mismatches        INTEGER NOT NULL DEFAULT 0,
  details_json      TEXT
);
`;

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

/**
 * Rellena orders.release_window_id a partir de pickup_day.
 *
 * Es idempotente: solo toca las filas que siguen en NULL. Un pedido con
 * pickup_day que no matchea ninguna ventana se queda en NULL a proposito — es
 * un huerfano y dejarlo explicito es mejor que apuntarlo a una ventana
 * equivocada. La columna es nullable justamente para que esos casos se puedan
 * listar y revisar en vez de fallar en silencio.
 *
 * Si hay varias ventanas con la misma fecha (no deberia, pero el schema lo
 * permite), se toma la `open` mas antigua: es la que el POST de orders habria
 * usado, asi que es la que reconstruye el descuento real.
 */
function ensureBackfillOrderWindows() {
  const huerfanos = db.prepare(
    'SELECT COUNT(*) AS n FROM orders o WHERE o.release_window_id IS NULL'
  ).get().n;
  if (huerfanos === 0) return;

  db.exec(`
    UPDATE orders
    SET release_window_id = (
      SELECT rw.id FROM release_windows rw
      WHERE rw.release_date = orders.pickup_day
      ORDER BY (rw.status = 'open') DESC, rw.id ASC
      LIMIT 1
    )
    WHERE release_window_id IS NULL
      AND pickup_day IN (SELECT release_date FROM release_windows)
  `);

  const quedan = db.prepare(
    'SELECT COUNT(*) AS n FROM orders WHERE release_window_id IS NULL'
  ).get().n;
  if (quedan > 0) {
    console.warn(
      `[db] ${quedan} pedido(s) con pickup_day sin ventana correspondiente; quedan con ` +
      `release_window_id NULL a proposito (huerfanos, revisarlos).`
    );
  }
}

/**
 * Reconstruye `orders` para poder declarar la FK de release_window_id.
 *
 * SQLite no permite anadir una FK con ALTER TABLE ADD COLUMN. El procedimiento
 * estandar es crear la tabla nueva con el esquema deseado, copiar, borrar la
 * vieja y renombrar. Se hace UNA sola vez (idempotente: si la FK ya existe en
 * el esquema actual, no toca nada).
 *
 * `PRAGMA foreign_keys` se desactiva alrededor: sin eso, el DROP de la tabla
 * vieja podria disparar acciones referenciales de otras tablas que apuntan a
 * orders (payments.order_id es FK a orders.id).
 */
function ensureOrdersWindowForeignKey() {
  const rows = db.prepare('PRAGMA foreign_key_list(orders)').all();
  const yaLaTiene = rows.some(f => f.table === 'release_windows' && f.from === 'release_window_id');
  if (yaLaTiene) return;

  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get();
  if (!current) return;
  if (!/release_window_id/.test(current.sql)) return; // columna sin anadir todavia
  if (/FOREIGN KEY\s*\(\s*release_window_id/.test(current.sql)) return;

  // NO se reconstruye la tabla copiando PRAGMA table_info: eso pierde los
  // PRIMARY KEY, los UNIQUE y las CHECK del esquema original (la PK se queda
  // como un DEFAULT suelto), y los defaults con funcion como
  // `DEFAULT datetime('now')` se reescriben mal y rompen el CREATE.
  //
  // Se parte del SQL real que SQLite ya tiene guardado y se le anade la FK
  // antes del cierre del parentesis. Es la unica via que preserva el esquema.
  const original = current.sql.trim();
  const cierre = original.lastIndexOf(')');
  if (cierre === -1) return;

  const conFk = original.slice(0, cierre).trimEnd().replace(
    /,\s*$/, ''
  ) + `,
    FOREIGN KEY (release_window_id) REFERENCES release_windows(id) ON DELETE SET NULL
${original.slice(cierre)}`;

  console.log('[db] declarando la FK orders.release_window_id (una vez)');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE orders__migrate ${conFk.slice(conFk.indexOf('('))};
      INSERT INTO orders__migrate SELECT * FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders__migrate RENAME TO orders;
    `);
  } catch (e) {
    console.error('[db] no se pudo declarar la FK orders.release_window_id:', e.message);
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function init() {
  db.exec(SCHEMA);

  // Migraciones idempotentes para DBs creadas antes de estas columnas.
  // CREATE TABLE IF NOT EXISTS no altera tablas existentes, asi que las
  // columnas nuevas requieren ALTER explicito.
  ensureColumn('combos', 'units_available', 'INTEGER NOT NULL DEFAULT -1');
  ensureColumn('combos', 'units_sold', 'INTEGER NOT NULL DEFAULT 0');

  db.prepare('INSERT OR IGNORE INTO config (id) VALUES (1)').run();

  // Multi-número: al inicializar, si no hay destinatarios y la config ya tiene
  // un WhatsApp real (no placeholder), se importa como primer destinatario.
  const recipientCount = db.prepare('SELECT COUNT(*) as n FROM order_recipients').get().n;
  if (recipientCount === 0) {
    const cfg = db.prepare('SELECT whatsapp_number FROM config WHERE id = 1').get();
    const digits = String(cfg?.whatsapp_number || '').replace(/\D/g, '');
    if (digits && digits !== '573000000000' && /^\d{8,15}$/.test(digits)) {
      db.prepare('INSERT INTO order_recipients (label, phone, active, sort_order) VALUES (?, ?, 1, 0)')
        .run('Admin principal', digits);
    }
  }

  // 2026-10-17: se elimina el demote global de admins (antes: cualquier admin
  // distinto de admin@mymochis.app volvía a 'customer' en cada boot). El operador
  // pidió soporte multi-admin; los admins se gestionan por POST /api/users
  // (admin-only) y el register público sigue forzando role=customer.
  db.exec("UPDATE config SET instagram_handle = '@my.mochiss', instagram_url = 'https://instagram.com/my.mochiss/', tiktok_handle = '@my.mochiss' WHERE id = 1 AND (instagram_handle = '@mymochis.neiva' OR instagram_handle IS NULL OR tiktok_handle IS NULL)");

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && adminPassword.length >= 8) {
    const adminEmailLower = adminEmail.toLowerCase().trim();
    const existingAdmin = db.prepare('SELECT id, role FROM users WHERE email = ?').get(adminEmailLower);
    if (!existingAdmin) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(adminPassword, salt, 64).toString('hex');
      db.prepare(
        'INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, ?)'
      ).run(adminEmailLower, hash, salt, 'Admin', 'admin');
      console.log(`[mymochis] admin seed creado: ${adminEmailLower}`);
    } else {
      if (existingAdmin.role !== 'admin') {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existingAdmin.id);
        console.log(`[mymochis] admin role restaurado: ${adminEmailLower}`);
      }
      if (process.env.ADMIN_PASSWORD_RESET === 'true') {
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(adminPassword, salt, 64).toString('hex');
        db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, existingAdmin.id);
        console.log(`[mymochis] admin password rotada via ADMIN_PASSWORD_RESET: ${adminEmailLower}`);
      }
    }
  } else if (adminEmail || adminPassword) {
    console.warn('[mymochis] ADMIN_EMAIL/ADMIN_PASSWORD presentes pero password <8 chars — admin NO creado. Setear password >=8 chars o usar /register con role forzado.');
  }

  ensureColumn('config',  'delivery_immediate_enabled',        'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('config',  'delivery_immediate_fee_cents',      'INTEGER NOT NULL DEFAULT 5000');
  // Tarifa por distancia estilo DiDi/Rappi (pesos COP, como todos los *_cents):
  //   domicilio = base_fare + price_per_km × km (redondeado a $50).
  // Defaults en 0 = tarifa plana histórica hasta que el admin las configure
  // en Entregas → Inmediato. Referencia Neiva: base $3.500, $1.600/km.
  ensureColumn('config',  'delivery_immediate_base_fare_cents',   'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('config',  'delivery_immediate_price_per_km_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('config',  'delivery_immediate_radius_km',      'INTEGER NOT NULL DEFAULT 5');
  ensureColumn('config',  'delivery_immediate_min_order_cents','INTEGER NOT NULL DEFAULT 20000');
  ensureColumn('config',  'delivery_immediate_eta_minutes',    'INTEGER NOT NULL DEFAULT 45');
  ensureColumn('config',  'delivery_zone_label',               "TEXT NOT NULL DEFAULT 'Neiva urbana'");
  ensureColumn('config',  'delivery_zone_center_lat',          'REAL');
  ensureColumn('config',  'delivery_zone_center_lng',          'REAL');
  ensureColumn('config',  'delivery_default_cutoff_hours',     'INTEGER NOT NULL DEFAULT 8');
  ensureColumn('config',  'production_units_per_batch',        'INTEGER NOT NULL DEFAULT 50');
  ensureColumn('config',  'production_target_margin_pct',       'INTEGER NOT NULL DEFAULT 70');

  ensureColumn('orders',  'delivery_mode',         "TEXT CHECK(delivery_mode IN ('scheduled','immediate')) DEFAULT 'scheduled'");
  ensureColumn('orders',  'delivery_provider',     "TEXT NOT NULL DEFAULT 'own'");
  ensureColumn('orders',  'delivery_address',      'TEXT');
  ensureColumn('orders',  'delivery_lat',          'REAL');
  ensureColumn('orders',  'delivery_lng',          'REAL');
  ensureColumn('orders',  'delivery_distance_km',  'REAL');
  ensureColumn('orders',  'delivery_fee_cents',    'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('orders',  'payment_method_id',     'INTEGER REFERENCES payment_methods(id)');

  ensureColumn('flavors', 'category_id', 'INTEGER REFERENCES categories(id)');

  // 2026-10-19: backend de pagos v1 (Spec §22.5) — extender payment_methods y orders
  ensureColumn('payment_methods', 'provider',   'TEXT');
  ensureColumn('payment_methods', 'enabled',    'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('payment_methods', 'credentials_ref', 'TEXT');
  ensureColumn('orders', 'payment_id',    'TEXT REFERENCES payments(payment_id)');
  ensureColumn('orders', 'payment_state', 'TEXT');

  // El telefono del cliente es la llave con la que se filtra SU propio pedido:
  // `GET /api/orders` solo le muestra lo suyo, no el libro completo. Sin esta
  // columna el JWT no puede llevar el telefono y el filtro no tiene con que
  // comparar (2026-10-21, bug de PII).
  ensureColumn('users', 'phone', 'TEXT');

  // El pedido debe guardar a QUE ventana consumio stock, no solo la fecha.
  // `pickup_day` es un TEXT libre: si el formato cambia o hay typo, la
  // contabilidad de stock se rompe en silencio y no hay forma de detectar que
  // pedido+zona se Discountaron de mas. Con la FK, esa reconciliacion es una
  // query y el motor rechaza el pedido huerfano.
  //
  // SQLite no puede agregar una FK con ALTER TABLE ADD COLUMN (solo columnas),
  // asi que se reconstruye la tabla conservando los datos. Es la razon por la
  // que el backfill va aqui y no en un simple ensureColumn.
  ensureColumn('orders', 'release_window_id', 'INTEGER');
  ensureBackfillOrderWindows();
  ensureOrdersWindowForeignKey();

  // === Tres pools de stock (disponible / reservado / vendido) ===
  //
  // El negocio cobra por transferencia manual: entre que el cliente pide y que
  // el operador confirma el pago hay horas. Con el modelo de dos contadores
  // (units_available vs units_sold) un pedido que NUNCA se paga bloqueaba
  // stock igual de un pedido pagado: el operador terminaba produciendo para
  // pedidos fantasma y la app decia "agotado" con producto en la cocina.
  //
  // Ahora hay una RESERVA explicita:
  //   reserved  = pedido creado, pago pendiente
  //   sold      = pago confirmado
  // Lo que se puede prometer es available - reserved - sold.
  //
  // Decidido con el operador (2026-10-21): la reserva NO expira sola. Si el
  // cliente no paga, el stock queda retenido hasta que el operador lo libere
  // cancelando el pedido. Es lo contrario de un TTL de carrito, y tiene
  // sentido aqui: el "checkout" es una transferencia que puede llegar a las
  // 11pm por un pedido de las 3pm.
  ensureColumn('release_items', 'units_reserved', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('combos', 'units_reserved', 'INTEGER NOT NULL DEFAULT 0');

  const catCount = db.prepare('SELECT COUNT(*) as n FROM categories').get().n;
  if (catCount === 0) {
    const stmt = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
    for (const c of SEED_CATEGORIES) stmt.run(c.name, c.slug, c.sort_order);
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