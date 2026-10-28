// MyMochis · Regresión de tarifa de domicilio por distancia (spec_id=30 G2)
//
// La fórmula vive en src/lib/delivery-fee.js y la comparten el quote del
// carrito (POST /api/delivery/quote) y POST /api/orders: este test fija que
// las dos no puedan divergir. Los tests del endpoint cubren los guards que
// no tocan la red: 400 antes de geocodificar y 503 con el domicilio apagado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDeliveryFeeCents } from '../src/lib/delivery-fee.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 4177-4183, 4187, 4189-4191, 4193 y 4195 ya los usan otros test/*.test.js.
const PORT = 4197;
const BASE = `http://localhost:${PORT}`;

test('tarifa: precio por km en 0 cae a la tarifa plana histórica', () => {
  const cfg = { delivery_immediate_fee_cents: 5000, delivery_immediate_price_per_km_cents: 0, delivery_immediate_base_fare_cents: 0 };
  assert.equal(computeDeliveryFeeCents(cfg, 3.2), 5000);
});

test('tarifa: base + precio por km, redondeado a $50 (estilo DiDi)', () => {
  const cfg = { delivery_immediate_fee_cents: 5000, delivery_immediate_base_fare_cents: 3500, delivery_immediate_price_per_km_cents: 1600 };
  assert.equal(computeDeliveryFeeCents(cfg, 3.2), 8600);
  assert.equal(computeDeliveryFeeCents(cfg, 0), 3500);
  assert.equal(computeDeliveryFeeCents(cfg, null), 3500);
});

test('tarifa: sin config no inventa cobros', () => {
  assert.equal(computeDeliveryFeeCents({}, 4), 0);
  assert.equal(computeDeliveryFeeCents(null, 4), 0);
});

test('tarifa: un día gratis autorizado devuelve cero', () => {
  const cfg = { delivery_immediate_fee_cents: 5000, delivery_immediate_base_fare_cents: 3500, delivery_immediate_price_per_km_cents: 1600 };
  assert.equal(computeDeliveryFeeCents(cfg, 3.2, { freeDelivery: true }), 0);
});

let child;
let tmpDir;

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

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-delivery-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL: 'admin@dlv.test',
      ADMIN_PASSWORD: 'DlvTest123!',
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('POST /api/delivery/quote sin dirección → 400', async () => {
  const r = await fetch(`${BASE}/api/delivery/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
});

test('POST /api/delivery/quote con domicilio apagado → 503, mensaje en español', async () => {
  const r = await fetch(`${BASE}/api/delivery/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'Calle 12 #34-56, Neiva' }),
  });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'delivery_disabled');
  assert.ok(j.message.length > 5, 'debe explicar el por qué al usuario');
});
