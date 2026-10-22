// MyMochis · Grafo de transiciones de pago (auditoria 2026-10-21, bug #5).
//
// Antes transitionState solo validaba que el estado destino existiera, asi que
// cualquier estado podia pasar a cualquier otro. El caso que rompia el dinero:
// un webhook "aprobado" cobraba el pago, y un webhook "rechazado" posterior —
// del mismo o de otro proveedor, con otro event id — lo deshacia. El pedido
// volvia a "por cobrar" con el dinero ya en la cuenta: el operador cobraba dos
// veces o perdia el cobro.
//
// Este test reproduce exactamente esa secuencia y verifica que:
//   1. el webhook de aprobacion SÍ cobra (el grafo no puede bloquear el flujo
//      legitimo),
//   2. el webhook contradictorio posterior NO deshace el cobro,
//   3. la reversa del operador (refund) sigue funcionando: es la unica salida
//      legitima de SUCCEEDED y la exige el negocio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4193;   // 4177-4187, 4189, 4190, 4191 ya usados
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@graph.local';
const ADMIN_PASSWORD = 'GraphTest123!';
const MOCK_SECRET = 'graph-test-secret';

let child, tmpDir, token, orderId, paymentId, providerRef, windowDate;

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

async function api(method, path, { token: t, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (t) h['Authorization'] = `Bearer ${t}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function DB_PATH() { return join(tmpDir, 'test.db'); }

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH());
  try { return fn(db); } finally { db.close(); }
}

/** Webhook firmado. EL body va por `body` para que express.json capture
    req.rawBody, que es lo que se verifica. */
async function webhook(payload, eventId) {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', MOCK_SECRET).update(body).digest('hex');
  return fetch(`${BASE}/api/webhooks/mock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mock-signature': sig,
      'x-mock-event-id': eventId,
    },
    body,
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

let n = 0;
const uniq = () => `graph-${Date.now().toString(36)}-${n++}`;

async function estado() {
  const pago = await api('GET', `/api/payments/${paymentId}`, { token });
  const pedido = await api('GET', `/api/orders/${orderId}`, { token });
  return {
    pago: pago.json?.payment?.state ?? pago.json?.state,
    pedido: pedido.json?.payment_status,
  };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-graph-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD, MYMOCHIS_NO_WORKERS: '1',
      PAYMENT_MOCK_WEBHOOK_SECRET: MOCK_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();

  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = r.json.token;
  assert.ok(token, 'login fallo');

  await api('POST', '/api/flavors', { token, body: { id: 'graph-fresa', name: 'Graph Fresa', price: 8000, available: 1 } });
  const d = new Date(Date.now() + 4 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token,
    body: { release_date: windowDate, cutoff_at: `${windowDate}T09:00:00`, status: 'open',
            items: [{ flavor_id: 'graph-fresa', units_available: 50 }] },
  });
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: new Date(`${windowDate}T12:00:00Z`).getUTCDay(), mode: 'both',
            start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
  });

  orderId = uniq();
  const o = await api('POST', '/api/orders', {
    token,
    body: { id: orderId, customer_name: 'Graph', customer_phone: '573213050426',
            pickup_day: windowDate, items: { 'graph-fresa': 2 }, combos: [], total: 16000, source: 'test' },
  });
  assert.equal(o.status, 201, `pedido fallo: ${JSON.stringify(o.json)}`);

  // Pago real por la API de pagos (no el flujo manual).
  const p = await api('POST', '/api/payments', {
    token,
    headers: { 'Idempotency-Key': uniq() },
    body: { order_id: orderId, amount_minor: 16000, currency: 'COP',
            provider: 'mock', customer_phone: '573213050426' },
  });
  assert.equal(p.status, 201, `pago fallo: ${JSON.stringify(p.json)}`);
  paymentId = p.json.payment_id;

  // El provider_reference del intent es lo que el webhook cita.
  providerRef = withDb(d => d.prepare(
    'SELECT provider_reference FROM payment_attempts WHERE payment_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(paymentId)?.provider_reference);
  assert.ok(providerRef, 'sin provider_reference');
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('el webhook de aprobacion SI cobra (el grafo no bloquea el flujo legitimo)', async () => {
  const antes = await estado();
  assert.notEqual(antes.pago, 'SUCCEEDED');

  const r = await webhook({ type: 'payment.approved', payment_id: paymentId, provider_reference: providerRef }, `evt-${uniq()}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.applied, 'SUCCEEDED', `el webhook debe aplicar SUCCEEDED: ${JSON.stringify(r.json)}`);

  const despues = await estado();
  assert.equal(despues.pago, 'SUCCEEDED');
  assert.equal(despues.pedido, 'paid');
});

test('un webhook contradictorio NO deshace un cobro real', async () => {
  // El dinero ya entro (test anterior o este flujo). Llega un "rechazado"
  // con otro event id — el escenario que antes devolvia el pedido a
  // "por cobrar" con el dinero dentro.
  const antes = await estado();
  assert.equal(antes.pago, 'SUCCEEDED', 'precondicion: el pago esta cobrado');

  const r = await webhook({ type: 'payment.rejected', payment_id: paymentId, provider_reference: providerRef }, `evt-${uniq()}`);
  assert.equal(r.status, 200, 'el webhook se acepta (el proveedor no debe romper)');
  assert.match(String(r.json.applied), /rechazado:illegal_transition/,
    `la transicion debe rechazarse por el grafo: ${JSON.stringify(r.json)}`);

  const despues = await estado();
  assert.equal(despues.pago, 'SUCCEEDED', 'un pago cobrado no se deshace');
  assert.equal(despues.pedido, 'paid', 'el pedido sigue pagado');
});

test('la reversa del OPERADOR sigue funcionando (unica salida legitima)', async () => {
  // El refund es el camino que el negocio necesita cuando el operador se
  // equivoca. El grafo no puede cerrar esta puerta.
  //
  // Se ejercita con el flujo MANUAL (confirm-payment + refund), que es el que
  // el operador usa en el panel y el unico que revertManualPayment acepta:
  // revertir un pago de proveedor exige conciliar con el proveedor, no solo
  // tocar la fila local.
  const orden = uniq();
  const o = await api('POST', '/api/orders', {
    token,
    body: { id: orden, customer_name: 'Graph', customer_phone: '573213050426',
            pickup_day: windowDate, items: { 'graph-fresa': 1 }, combos: [], total: 8000, source: 'test' },
  });
  assert.equal(o.status, 201);

  const c = await api('POST', `/api/orders/${orden}/confirm-payment`, { token, body: {} });
  assert.equal(c.status, 201, `confirmacion fallo: ${JSON.stringify(c.json)}`);
  assert.equal(c.json.state, 'SUCCEEDED');

  const r = await api('POST', `/api/payments/${c.json.payment_id}/refund`, {
    token, body: { reason: 'pago reportado dos veces por el cliente' },
  });
  assert.equal(r.status, 200, `refund fallo: ${JSON.stringify(r.json)}`);

  const despues = await api('GET', `/api/orders/${orden}`, { token });
  assert.equal(despues.json.payment_status, 'pending',
    'la reversa del operador devuelve el pedido a pendiente');
});