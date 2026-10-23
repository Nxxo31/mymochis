// MyMochis · Regresión del camino automático de pagos (spec §22.7, 2026-10-23).
//
// El server Express registraba los consumers del outbox pero NADIE drenaba la
// cola: un pago confirmado por webhook dejaba el pedido "por cobrar" para
// siempre y la reserva nunca se convertía en venta. Este archivo fija la cadena
// completa: webhook mock → transition → outbox → relay → consumer → pedido
// pagado + stock comprometido. Corre con workers activos (sin
// MYMOCHIS_NO_WORKERS) y el relay a 500ms via MYMOCHIS_OUTBOX_RELAY_INTERVAL_MS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 4177-4183, 4187, 4189-4191 y 4193 ya los usan otros test/*.test.js y node
// --test corre los archivos en paralelo.
const PORT = 4195;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@autoflow.local';
const ADMIN_PASSWORD = 'AutoFlowTest123!';
const MOCK_SECRET = 'autoflow-secret';
const FLAVOR_ID = 'auto-fresa';
const QTY = 2;
const WINDOW_DATE = '2026-12-02';

let child, tmpDir, adminToken, windowId, orderId, orderTotal, paymentId, providerRef;

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
  const estado = !child ? 'sin child'
    : (child.exitCode !== null || child.signalCode !== null)
      ? `child muerto (exit=${child.exitCode}, signal=${child.signalCode})`
      : `child vivo tras ${timeoutMs}ms pero /api/health nunca respondió`;
  throw new Error(`server did not start — ${estado}`);
}

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function getOrder() {
  const r = await api('GET', `/api/orders/${orderId}`, { token: adminToken });
  assert.equal(r.status, 200, `GET order falló: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function flavorPools() {
  const r = await api('GET', `/api/release-windows/${windowId}`, { token: adminToken });
  assert.equal(r.status, 200, `GET release-window falló: ${JSON.stringify(r.json)}`);
  const item = (r.json.items || []).find(i => i.flavor_id === FLAVOR_ID);
  assert.ok(item, 'item del flavor no encontrado en la ventana');
  return { reserved: item.units_reserved || 0, sold: item.units_sold || 0 };
}

async function webhook(eventId, payload) {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', MOCK_SECRET).update(body).digest('hex');
  const res = await fetch(`${BASE}/api/webhooks/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-event-id': eventId, 'x-mock-signature': sig },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function waitFor(cond, timeoutMs = 15000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cond();
    if (last) return last;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return last;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-autoflow-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      PAYMENT_MOCK_WEBHOOK_SECRET: MOCK_SECRET,
      MYMOCHIS_OUTBOX_RELAY_INTERVAL_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();

  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.ok(login.json?.token, 'login admin falló');
  adminToken = login.json.token;

  await api('POST', '/api/flavors', { token: adminToken, body: { id: FLAVOR_ID, name: 'Auto Fresa', price: 8000, available: 1 } });
  const rw = await api('POST', '/api/release-windows', {
    token: adminToken,
    body: { release_date: WINDOW_DATE, cutoff_at: `${WINDOW_DATE}T09:00:00`, status: 'open', items: [{ flavor_id: FLAVOR_ID, units_available: 12 }] },
  });
  assert.ok(rw.status === 200 || rw.status === 201, `release window falló: ${JSON.stringify(rw.json)}`);
  windowId = rw.json?.id;

  const order = await api('POST', '/api/orders', {
    token: adminToken,
    body: {
      id: 'MYM-AUTO-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      customer_name: 'Auto Flow',
      customer_phone: '+573001234567',
      pickup_day: WINDOW_DATE,
      items: { [FLAVOR_ID]: QTY },
      combos: [],
      total: 8000 * QTY,
      notes: 'auto flow test',
      source: 'test',
    },
  });
  assert.equal(order.status, 201, `order create falló: ${JSON.stringify(order.json)}`);
  orderId = order.json.id;
  orderTotal = order.json.pricing?.total ?? order.json.total;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('webhook → relay → consumer: pedido pagado y stock comprometido', async () => {
  const base = await flavorPools();
  assert.equal(base.reserved, QTY, 'el pedido debe nacer con la reserva retenida');
  assert.equal(base.sold, 0, 'sin pago confirmado no hay venta');

  const pay = await api('POST', '/api/payments', {
    token: adminToken,
    headers: { 'Idempotency-Key': 'autoflow-1' },
    body: { order_id: orderId, amount_minor: orderTotal, currency: 'COP', provider: 'mock', customer_phone: '573213050426', description: 'auto flow' },
  });
  assert.equal(pay.status, 201, JSON.stringify(pay.json));
  assert.equal(pay.json.state, 'REQUIRES_ACTION');
  paymentId = pay.json.payment_id;
  providerRef = pay.json.provider_reference;

  const wh = await webhook('autoflow-evt-1', { type: 'succeeded', status: 'SUCCESS', payment_id: paymentId, provider_reference: providerRef });
  assert.equal(wh.status, 200, JSON.stringify(wh.json));
  assert.equal(wh.json.applied, 'SUCCEEDED', `el webhook debía aplicar la transición: ${JSON.stringify(wh.json)}`);

  // El webhook marca payment_status='paid' sincrónicamente (transitionState),
  // pero el stock lo compromete el consumer async vía relay. Esperar el efecto
  // de negocio completo, no la denormalización intermedia.
  const settled = await waitFor(async () => {
    const o = await getOrder();
    if (o.payment_status !== 'paid') return false;
    const p = await flavorPools();
    return p.reserved === 0 && p.sold === QTY;
  });
  assert.ok(settled, 'el relay nunca comprometió el stock del pedido pagado (timeout 15s)');

  const o = await getOrder();
  assert.equal(o.payment_status, 'paid');
  assert.equal(o.payment_state, 'SUCCEEDED', 'payment_state debe quedar con el estado real del grafo, no con el dominio');

  const pools = await flavorPools();
  assert.equal(pools.reserved, 0, 'la reserva debía convertirse en venta');
  assert.equal(pools.sold, QTY, 'las unidades reservadas debían pasar a units_sold');
});

test('replays y webhooks contradictorios no venden dos veces', async () => {
  const dup = await webhook('autoflow-evt-1', { type: 'succeeded', status: 'SUCCESS', payment_id: paymentId, provider_reference: providerRef });
  assert.equal(dup.status, 200, JSON.stringify(dup.json));
  assert.equal(dup.json.deduped, true, 'el mismo event-id debe deduplicar');

  const contra = await webhook('autoflow-evt-2', { type: 'rejected', status: 'REJECTED', payment_id: paymentId, provider_reference: providerRef });
  assert.equal(contra.status, 200, JSON.stringify(contra.json));
  assert.equal(contra.json.applied, 'rechazado:illegal_transition', `SUCCEEDED es punto de no retorno: ${JSON.stringify(contra.json)}`);

  await new Promise(r => setTimeout(r, 1200));
  const o = await getOrder();
  assert.equal(o.payment_status, 'paid', 'el replay no puede despagar el pedido');
  assert.equal(o.payment_state, 'SUCCEEDED');
  const pools = await flavorPools();
  assert.equal(pools.sold, QTY, 'el replay no puede vender las unidades dos veces');
  assert.equal(pools.reserved, 0);
});
