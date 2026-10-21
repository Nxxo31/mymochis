// MyMochis · Flujo de pago MANUAL (el caso real del negocio)
//
// El negocio cobra off-platform: el cliente transfiere a la cuenta y el
// operador confirma. Estos tests cubren ese ciclo completo: confirmar → ledger
// cuadrando a cero → pedido pagado → idempotencia → reversa.
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
const PORT = 4183;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@manual.local';
const ADMIN_PASSWORD = 'ManualTest123!';
const DB_PATH = () => join(tmpDir, 'test.db');

let child, tmpDir, adminToken, customerToken, windowDate, flavorId;

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, text: await res.text().catch(() => '') };
}

/** Lee la DB del test mientras el server vive (node:sqlite permite multi-conexión). */
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH());
  try { return fn(db); } finally { db.close(); }
}

let n = 0;
const uniq = () => `MAN-${Date.now().toString(36)}-${n++}`;

async function makeOrder(total = null) {
  const r = await api('POST', '/api/orders', {
    token: adminToken,
    body: {
      id: uniq(), customer_name: 'Cliente Man', customer_phone: '573213050426',
      pickup_day: windowDate, items: { [flavorId]: 1 }, combos: [], total: total ?? 8000,
      source: 'test',
    },
  });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-manual-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: DB_PATH(),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD,
      MYMOCHIS_NO_WORKERS: '1',   // sin workers: probamos el camino síncrono
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();

  adminToken = (await api('POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })).json.token;

  flavorId = 'man-' + Date.now().toString(36);
  await api('POST', '/api/flavors', {
    token: adminToken, body: { id: flavorId, name: 'Sabor Test', price: 8000, available: 1 },
  });
  const d = new Date(Date.now() + 3 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token: adminToken,
    body: { release_date: windowDate, cutoff_at: `${windowDate}T09:00:00`, status: 'open',
            items: [{ flavor_id: flavorId, units_available: 500 }] },
  });
  await api('POST', '/api/delivery-schedule', {
    token: adminToken,
    body: { day_of_week: new Date(`${windowDate}T12:00:00Z`).getUTCDay(), mode: 'both',
            start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
  });

  customerToken = (await api('POST', '/api/auth/register', {
    body: { email: 'cliente@manual.local', password: 'ClienteTest123!', name: 'Cliente' },
  })).json?.token;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// =============================================================================
// RBAC
// =============================================================================

test('confirm-payment — sin token 401; customer 403', async () => {
  const o = await makeOrder();
  assert.equal((await api('POST', `/api/orders/${o.id}/confirm-payment`, { body: {} })).status, 401);
  if (customerToken) {
    assert.equal((await api('POST', `/api/orders/${o.id}/confirm-payment`, {
      token: customerToken, body: {},
    })).status, 403);
  }
});

test('confirm-payment — pedido inexistente → 404', async () => {
  const r = await api('POST', '/api/orders/NO-EXISTE-123/confirm-payment', { token: adminToken, body: {} });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'order_not_found');
});

// =============================================================================
// El ciclo principal
// =============================================================================

test('confirm-payment — confirma y postea un ledger que cuadra a cero', async () => {
  const o = await makeOrder();
  assert.equal(o.total, 8000, 'el server calcula el total desde el catálogo');

  const r = await api('POST', `/api/orders/${o.id}/confirm-payment`, {
    token: adminToken, body: { reference: 'NEQUI-8891', note: 'Transferencia recibida 14:30' },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.state, 'SUCCEEDED');
  assert.equal(r.json.amount, 8000);
  assert.ok(r.json.payment_id.startsWith('pay_'));

  // El ledger debe sumar cero (partida doble).
  const ledger = withDb(db => db.prepare(`
    SELECT account, amount_minor FROM ledger_entries WHERE payment_id = ? ORDER BY account
  `).all(r.json.payment_id));
  assert.equal(ledger.length, 2, `deben ser 2 entradas, hay ${ledger.length}`);
  assert.equal(ledger[0].account, 'customer_cash');
  assert.equal(ledger[0].amount_minor, 8000);
  assert.equal(ledger[1].account, 'merchant_receivable');
  assert.equal(ledger[1].amount_minor, -8000);
  assert.equal(ledger.reduce((a, l) => a + l.amount_minor, 0), 0, 'el ledger debe cuadrar a cero');
});

test('confirm-payment — el pedido queda marcado como pagado', async () => {
  const o = await makeOrder();
  await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });

  const after = await api('GET', `/api/orders/${o.id}`, { token: adminToken });
  assert.equal(after.json.payment_status, 'paid');
  assert.equal(after.json.payment_state, 'SUCCEEDED');
  assert.ok(after.json.payment_id, 'el pedido enlaza al payment');
});

test('confirm-payment — idempotente: confirmar dos veces no duplica', async () => {
  const o = await makeOrder();
  const first = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });
  const second = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.already_confirmed, true);
  assert.equal(second.json.payment_id, first.json.payment_id, 'mismo payment_id');

  const count = withDb(db => db.prepare(
    "SELECT COUNT(*) n FROM payments WHERE order_id = ? AND state = 'SUCCEEDED'"
  ).get(o.id).n);
  assert.equal(count, 1, `debe haber 1 pago, hay ${count}`);

  // Y tampoco duplica el ledger.
  const entries = withDb(db => db.prepare(
    'SELECT COUNT(*) n FROM ledger_entries WHERE payment_id = ?'
  ).get(first.json.payment_id).n);
  assert.equal(entries, 2, 'no debe duplicar entradas del ledger');
});

test('confirm-payment — monto distinto al pedido → 409', async () => {
  const o = await makeOrder();
  const r = await api('POST', `/api/orders/${o.id}/confirm-payment`, {
    token: adminToken, body: { amount: 1 },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'amount_mismatch');
  assert.equal(r.json.details.expected, 8000);
});

test('confirm-payment — el monto enviado puede omitirse (usa orders.total)', async () => {
  const o = await makeOrder();
  const r = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });
  assert.equal(r.status, 201);
  assert.equal(r.json.amount, o.total);
});

// =============================================================================
// Reversa
// =============================================================================

test('refund — sin motivo → 400', async () => {
  const o = await makeOrder();
  const c = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });
  const r = await api('POST', `/api/payments/${c.json.payment_id}/refund`, {
    token: adminToken, body: { reason: 'x' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'reason_required');
});

test('refund — la reversa descuenta el ledger y devuelve el pedido a pendiente', async () => {
  const o = await makeOrder();
  const c = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });

  const r = await api('POST', `/api/payments/${c.json.payment_id}/refund`, {
    token: adminToken, body: { reason: 'El clienteReportó pago duplicado' },
  });
  assert.equal(r.status, 200, r.text);

  // 4 entradas: las 2 originales + las 2 contrarias. Sigue cuadrando a cero.
  const ledger = withDb(db => db.prepare(
    'SELECT amount_minor FROM ledger_entries WHERE payment_id = ?'
  ).all(c.json.payment_id).map(l => l.amount_minor));
  assert.equal(ledger.length, 4);
  assert.equal(ledger.reduce((a, x) => a + x, 0), 0, 'tras la reversa el ledger sigue en cero');

  // El pedido vuelve a pendiente (dominio pending|paid).
  const after = await api('GET', `/api/orders/${o.id}`, { token: adminToken });
  assert.equal(after.json.payment_status, 'pending');
  assert.equal(after.json.payment_state, 'REVERTED');

  // Y puede volver a confirmarse (el flujo se reabre).
  const again = await api('POST', `/api/orders/${o.id}/confirm-payment`, { token: adminToken, body: {} });
  assert.equal(again.status, 201);
});

test('refund — un pago que no es manual se rechaza con mensaje claro', async () => {
  const o = await makeOrder();
  const c = await api('POST', '/api/payments', {
    token: adminToken,
    headers: { 'Idempotency-Key': uniq() },
    body: { order_id: o.id, amount_minor: o.total, provider: 'mock', customer_phone: '573213050426' },
  });
  assert.equal(c.status, 201, c.text);
  const r = await api('POST', `/api/payments/${c.json.payment_id}/refund`, {
    token: adminToken, body: { reason: 'prueba de provider' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'not_manual');
});

// =============================================================================
// El resumen que ve el operador
// =============================================================================

test('summary — cuenta lo cobrado y lo que falta confirmar', async () => {
  const a = await makeOrder();
  await api('POST', `/api/orders/${a.id}/confirm-payment`, { token: adminToken, body: {} });
  const b = await makeOrder();   // este NO se confirma

  const r = await api('GET', '/api/payments/summary', { token: adminToken });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.unit, 'pesos');

  const succeeded = r.json.by_state.find(s => s.state === 'SUCCEEDED');
  assert.ok(succeeded, 'debe existir el bucket SUCCEEDED');
  assert.ok(succeeded.total >= a.total, `debe incluir el pago de ${a.id}`);

  assert.ok(r.json.unconfirmed_count >= 1);
  assert.ok(r.json.unconfirmed.some(o => o.id === b.id), `${b.id} debe aparecer como no confirmado`);

  // El ledger global debe cuadrar: por pago suma cero, así que el total global también.
  const sum = r.json.ledger_balances.reduce((a, x) => a + Number(x.balance), 0);
  assert.equal(sum, 0, `ledger global desbalanceado: ${sum}`);
  assert.equal(r.json.ledger_unbalanced.length, 0, 'ningún pago debe quedar descuadrado');
});

test('summary — RBAC: customer no ve el resumen financiero', async () => {
  assert.equal((await api('GET', '/api/payments/summary')).status, 401);
  if (customerToken) {
    assert.equal((await api('GET', '/api/payments/summary', { token: customerToken })).status, 403);
  }
});

test('mismatches — vacío cuando el ledger está sano', async () => {
  const r = await api('GET', '/api/payments/mismatches', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 0, `esperaba 0 discrepancias, hay ${r.json.count}: ${JSON.stringify(r.json.mismatches)}`);
});

test('reconcile/runs — devuelve el historial sin error', async () => {
  const r = await api('GET', '/api/payments/reconcile/runs', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.runs));
});