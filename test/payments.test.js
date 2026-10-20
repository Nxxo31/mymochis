// MyMochis · Payments API tests (Spec §22)
// Patrón: server arrancado en subprocess con DB temporal + workers desactivados.
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
const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminTest123!';
const MOCK_SECRET = 'mock-secret';

let child;
let tmpDir;
let adminToken;
let testOrderId;

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server did not start');
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

async function loginAdmin() {
  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(r.status, 200, `admin login failed: ${JSON.stringify(r.json)}`);
  adminToken = r.json.token;
  return adminToken;
}

async function createTestOrder() {
  // 1. Crear flavor via API
  const flRes = await api('POST', '/api/flavors', {
    token: adminToken,
    body: { id: 'test-pay-fresa', name: 'Test Fresa', price: 8000, available: 1 },
  });
  if (flRes.status !== 201 && flRes.status !== 200) {
    throw new Error(`flavor create failed: ${flRes.status} ${JSON.stringify(flRes.json)}`);
  }
  // 2. Crear release_window
  const rwRes = await api('POST', '/api/release-windows', {
    token: adminToken,
    body: {
      release_date: '2026-12-01',
      cutoff_at: '2026-12-01T09:00:00',
      status: 'open',
      items: [{ flavor_id: 'test-pay-fresa', units_available: 100 }],
    },
  });
  if (rwRes.status !== 201 && rwRes.status !== 200) {
    throw new Error(`release_window create failed: ${rwRes.status} ${JSON.stringify(rwRes.json)}`);
  }
  // 3. Crear pedido
  const orderId = 'MYM-TEST-' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const orderPayload = {
    id: orderId,
    customer_name: 'Test Customer',
    customer_phone: '+573001234567',
    pickup_day: '2026-12-01',
    items: { 'test-pay-fresa': 2 },
    combos: [],
    total: 16000,
    notes: 'payments test',
    source: 'test',
  };
  const r = await api('POST', '/api/orders', { token: adminToken, body: orderPayload });
  if (r.status !== 201) {
    throw new Error(`order create failed: ${r.status} ${JSON.stringify(r.json)}`);
  }
  testOrderId = r.json.order?.id || r.json.id || orderId;
  return testOrderId;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-pay-test-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      MYMOCHIS_NO_WORKERS: '1',                 // disable async workers en tests
      PAYMENT_MOCK_WEBHOOK_SECRET: MOCK_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  await loginAdmin();
  await createTestOrder();
});

after(async () => {
  // Windows: child.kill() es async (TerminateProcess) y rmSync choca con los
  // handles que el child retiene sobre tmpDir (test.db de node:sqlite) → EPERM.
  // Patrón canónico de api/multiadmin.test.js + guard de child ya muerto.
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// =============================================================================
// §22.10 — POST /api/payments (create intent)
// =============================================================================

test('POST /api/payments — crea intent con provider mock → 201', async () => {
  const r = await api('POST', '/api/payments', {
    token: adminToken,
    headers: { 'Idempotency-Key': 'test-key-001' },
    body: {
      order_id: testOrderId,
      amount_minor: 16000,
      currency: 'COP',
      provider: 'mock',
      customer_phone: '+573001234567',
      description: 'Test payment',
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.payment_id?.startsWith('pay_'), 'payment_id debe existir y empezar con pay_');
  assert.equal(r.json.state, 'REQUIRES_ACTION', 'mock con phone debe dar REQUIRES_ACTION');
  assert.equal(r.json.provider, 'mock');
  assert.ok(r.json.whatsapp?.deep_link);
  testOrderId && (r.json.order_id === testOrderId);
});

test('POST /api/payments — sin Idempotency-Key → 400', async () => {
  const r = await api('POST', '/api/payments', {
    token: adminToken,
    body: {
      order_id: testOrderId,
      amount_minor: 16000,
      provider: 'mock',
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'idempotency_key_required');
});

test('POST /api/payments — validation: amount_minor negativo → 400', async () => {
  const r = await api('POST', '/api/payments', {
    token: adminToken,
    headers: { 'Idempotency-Key': 'test-key-invalid' },
    body: {
      order_id: testOrderId,
      amount_minor: -100,
      provider: 'mock',
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'validation');
  assert.ok(r.json.details.includes('amount_minor must be positive integer'));
});

test('POST /api/payments — misma idempotency key + mismo body → 200 cached', async () => {
  const body = {
    order_id: testOrderId,
    amount_minor: 8000,
    currency: 'COP',
    provider: 'mock',
    customer_phone: '+573001234567',
    description: 'cached test',
  };
  const r1 = await api('POST', '/api/payments', {
    token: adminToken, headers: { 'Idempotency-Key': 'test-key-cache' }, body,
  });
  assert.equal(r1.status, 201);
  const r2 = await api('POST', '/api/payments', {
    token: adminToken, headers: { 'Idempotency-Key': 'test-key-cache' }, body,
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.equal(r2.json.payment_id, r1.json.payment_id, 'mismo payment_id');
});

test('POST /api/payments — misma key + distinto body → 409 conflict', async () => {
  const r = await api('POST', '/api/payments', {
    token: adminToken,
    headers: { 'Idempotency-Key': 'test-key-cache' },
    body: { order_id: testOrderId, amount_minor: 99999, provider: 'mock' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'idempotency_mismatch');
});

// =============================================================================
// §22.8 — Webhook signature verify + dedupe
// =============================================================================

test('POST /api/webhooks/mock — sin signature → 401', async () => {
  const r = await fetch(`${BASE}/api/webhooks/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-event-id': 'evt-1' },
    body: JSON.stringify({ transactionId: 'X', status: 'SUCCESS' }),
  });
  assert.equal(r.status, 401);
});

test('POST /api/webhooks/mock — signature válida → 200, durable inbox', async () => {
  const body = JSON.stringify({ transactionId: 'MOCK-TEST-1', status: 'SUCCESS' });
  const sig = createHmac('sha256', MOCK_SECRET).update(body).digest('hex');
  const r = await fetch(`${BASE}/api/webhooks/mock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mock-signature': sig,
      'x-mock-event-id': 'evt-unique-1',
    },
    body,
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.ok, true);
  assert.ok(json.event_id?.startsWith('evt_'));
});

test('POST /api/webhooks/mock — mismo event_id → 200 deduped', async () => {
  const body = JSON.stringify({ transactionId: 'MOCK-TEST-2', status: 'SUCCESS' });
  const sig = createHmac('sha256', MOCK_SECRET).update(body).digest('hex');
  const opts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mock-signature': sig,
      'x-mock-event-id': 'evt-dedupe-1',
    },
    body,
  };
  const r1 = await fetch(`${BASE}/api/webhooks/mock`, opts);
  const r2 = await fetch(`${BASE}/api/webhooks/mock`, opts);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.ok, true);
  assert.equal(j2.deduped, true);
});

// =============================================================================
// §22.10 — GET endpoints
// =============================================================================

test('GET /api/payments/:id — desconocido → 404', async () => {
  const r = await api('GET', '/api/payments/pay_nonexistent', { token: adminToken });
  assert.equal(r.status, 404);
});

test('GET /api/payments — admin lista payments', async () => {
  const r = await api('GET', '/api/payments?limit=10', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.payments));
  assert.ok(r.json.payments.length > 0, 'debe haber al menos 1 payment de los tests anteriores');
});
