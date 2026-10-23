// MyMochis · Regresión de producción: costeo por lote, costo por unidad,
// precio sugerido por margen objetivo y contraste con ventas (spec_id=30 G3).
// El modelo es el de los software de costeo food: insumo × qty → costo lote →
// costo porción → precio sugerido. Si cambia la matemática, este test lo caza.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 4177-4183, 4187, 4189-4191, 4193, 4195 y 4197 ya están tomados.
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@prod.test';
const ADMIN_PASSWORD = 'ProdTest123!';

let child;
let tmpDir;
let token;

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

async function api(method, path, { body, token: t } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (t) h['Authorization'] = `Bearer ${t}`;
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-prod-test-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.ok(login.json?.token, 'login fallo');
  token = login.json.token;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('POST /api/production sin token → 401', async () => {
  const r = await api('POST', '/api/production', { body: { name: 'x', unit_cost_cents: 1, qty_per_batch: 1 } });
  assert.equal(r.status, 401);
});

test('insumos: alta, lista y costeo del lote', async () => {
  const a = await api('POST', '/api/production', { token, body: { name: 'Harina de arroz', unit: 'kg', unit_cost_cents: 3500, qty_per_batch: 2 } });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const b = await api('POST', '/api/production', { token, body: { name: 'Leche condensada', unit: 'lata', unit_cost_cents: 8000, qty_per_batch: 1 } });
  assert.equal(b.status, 201);
  const list = await api('GET', '/api/production', { token });
  assert.equal(list.json.items.length, 2);
});

test('summary: costo lote 15000, unidad 300 (50 uds), sugerido 1000 (margen 70%)', async () => {
  const s = await api('GET', '/api/production/summary', { token });
  assert.equal(s.status, 200);
  assert.equal(s.json.batch_cost_cents, 3500 * 2 + 8000 * 1);
  assert.equal(s.json.units_per_batch, 50);
  assert.equal(s.json.unit_cost_cents, 300);
  assert.equal(s.json.suggested_price_cents, 1000);
  assert.equal(s.json.items_count, 2);
});

test('settings: lote de 10 unidades → unidad 1500, sugerido 5000', async () => {
  const put = await api('PUT', '/api/production/settings', { token, body: { units_per_batch: 10, target_margin_pct: 70 } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const s = await api('GET', '/api/production/summary', { token });
  assert.equal(s.json.unit_cost_cents, 1500);
  assert.equal(s.json.suggested_price_cents, 5000);
  assert.equal(s.json.target_margin_pct, 70);
});

test('DELETE insumo → el costo del lote baja', async () => {
  const list = await api('GET', '/api/production', { token });
  const harina = list.json.items.find(i => i.name === 'Harina de arroz');
  const del = await api('DELETE', `/api/production/${harina.id}`, { token });
  assert.equal(del.status, 200);
  const s = await api('GET', '/api/production/summary', { token });
  assert.equal(s.json.items_count, 1);
  assert.equal(s.json.batch_cost_cents, 8000);
  assert.equal(s.json.unit_cost_cents, 800);
});

test('summary contrasta con ventas: DB nueva sin pedidos → ticket null, margen null', async () => {
  const s = await api('GET', '/api/production/summary', { token });
  assert.equal(s.json.paid_orders, 0);
  assert.equal(s.json.avg_ticket_cents, null);
  assert.equal(s.json.margin_vs_avg_ticket_pct, null);
});
