// MyMochis · Tests spec 59 (d1-d3): order_items, /api/inventory y /api/metrics.
// Server en subprocess con DB temporal. Siembra propia (no depende de seed-demo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@inventory.local';
const ADMIN_PASSWORD = 'InventoryTest123!';
const DB_PATH = () => join(tmpDir, 'test.db');

let child;
let tmpDir;
let adminToken;

async function waitReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) break;
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

async function api(method, path, { token, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function withDb(fn) {
  const db = new DatabaseSync(DB_PATH());
  try { return fn(db); } finally { db.close(); }
}

// Mañana en zona local, formateada para SQL.
const dia = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-inv-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEXOMOCHIS_DB_PATH: DB_PATH(), NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'), ADMIN_EMAIL, ADMIN_PASSWORD, MYMOCHIS_NO_WORKERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  adminToken = login.json.token;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
});

test('d1: order_items se escribe al crear el pedido y /api/inventory refleja stock', async () => {
  const d = dia();
  await withDb(db => {
    db.prepare('INSERT OR IGNORE INTO categories (name, slug, sort_order) VALUES (?, ?, 1)').run('clasicos', 'clasicos');
    const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('clasicos');
    db.prepare('INSERT OR IGNORE INTO flavors (id, name, price, color, category_id, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, 1)').run('inv-fresa', 'Fresa Test', 8000, '#FF0000', cat.id);
    db.prepare('INSERT INTO release_windows (release_date, cutoff_at, status, notes) VALUES (?, ?, \'open\', \'test\')').run(d, `${d}T09:00:00`);
    const w = db.prepare('SELECT id FROM release_windows WHERE release_date = ? LIMIT 1').get(d);
    db.prepare('INSERT OR IGNORE INTO release_items (window_id, flavor_id, units_available, units_sold, units_reserved) VALUES (?, ?, 30, 0, 0)').run(w.id, 'inv-fresa');
  });

  const orderId = `inv-${Date.now().toString(36)}`;
  const orden = await api('POST', '/api/orders', {
    body: {
      id: orderId, customer_name: 'Cliente Inv', customer_phone: '573001111111',
      pickup_day: d, items: { 'inv-fresa': 2 }, combos: [],
      total: 16000, source: 'test', delivery_mode: 'scheduled', delivery_address: 'Calle Falsa 123, Neiva',
    },
  });
  assert.equal(orden.status, 201, `pedido creado: ${JSON.stringify(orden.json)}`);
  await withDb(db => {
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(orderId).n > 0, 'order_items escrito al crear el pedido');
  });

  const inv = await api('GET', `/api/inventory?date=${d}`, { token: adminToken });
  assert.equal(inv.status, 200);
  const fila = inv.json.items.find(f => f.kind === 'product' && f.id === 'inv-fresa');
  assert.ok(fila, `el sabor inv-fresa aparece en el inventario`);
  assert.equal(fila.reserved, 2, 'reservado = 2');
  assert.equal(fila.sold, 0, 'vendido = 0');
  assert.equal(fila.producible, fila.available - 2, 'producible = disponible - reservado');
});

test('d3: /api/metrics con rango libre y by_status cuadrado con totals.count', async () => {
  const d = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await withDb(db => {
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('INSERT OR IGNORE INTO categories (name, slug, sort_order) VALUES (?, ?, 1)').run('clasicos-m', 'clasicos-m');
    const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('clasicos-m');
    db.prepare('INSERT OR IGNORE INTO flavors (id, name, price, color, category_id, available, sort_order) VALUES (?, ?, ?, ?, ?, 1, 1)').run('inv-m', 'Meta Test', 5000, '#000000', cat.id);
    db.prepare('INSERT INTO release_windows (release_date, cutoff_at, status, notes) VALUES (?, ?, \'open\', \'test\')').run(d, `${d}T09:00:00`);
    const w = db.prepare('SELECT id FROM release_windows WHERE release_date = ? LIMIT 1').get(d);
    db.prepare('INSERT INTO release_items (window_id, flavor_id, units_available, units_sold, units_reserved) VALUES (?, ?, 10, 0, 0)').run(w.id, 'inv-m');
    db.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, pickup_day, items_json, combos_json, total, status, payment_status, release_window_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', 'pending', ?, ?), (?, ?, ?, ?, ?, ?, ?, 'delivered', 'paid', ?, ?)
    `).run(`inv-m1-${Date.now()}`, 'C1', '573001111111', d, '{}', '[]', 5000, w.id, d, `inv-m2-${Date.now()}`, 'C2', '573001111112', d, '{}', '[]', 8000, w.id, d);
  });

  const m = await api('GET', `/api/metrics?from=2026-11-01&to=2026-11-30`, { token: adminToken });
  console.log('DEBUG d3 status:', m.status, 'body:', JSON.stringify(m.json));
  assert.equal(m.status, 200);
  assert.ok(m.json.totals, 'tiene totales');
  assert.ok(Array.isArray(m.json.by_status), 'tiene by_status');
  assert.ok(Array.isArray(m.json.by_delivery_mode), 'tiene desglose por modo de entrega');
  assert.ok(m.json.totals.count >= 1, 'hay al menos un pedido en el rango');
  assert.ok(m.json.by_status.length >= 1, 'hay al menos un estado');

  const m2 = await api('GET', `/api/metrics?from=${d}&to=${d}`, { token: adminToken });
  assert.equal(m2.status, 200);
});
