import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4177;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminTest123!';

let child;
let tmpDir;

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

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-test-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      NEXOMOCHIS_JWT_SECRET: 'test-secret-not-for-production',
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitReady();
});

after(async () => {
  if (child) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('GET /api/health responde 200', async () => {
  const { status, json } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.service, 'mymochis');
});

test('GET /api/public devuelve config pública', async () => {
  const { status, json } = await api('GET', '/api/public');
  assert.equal(status, 200);
  assert.ok(json.config?.business_name, 'business_name presente');
  assert.ok(Array.isArray(json.flavors), 'flavors presente');
  assert.ok(Array.isArray(json.combos), 'combos presente');
});

test('GET /api/flavors devuelve array', async () => {
  const { status, json } = await api('GET', '/api/flavors');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.data ?? json), 'lista de sabores');
});

test('register con role:admin queda forzado a customer (lockdown)', async () => {
  const { status, json } = await api('POST', '/api/auth/register', {
    body: { email: 'cust@test.local', password: 'CustPass123!', name: 'Cust', role: 'admin' },
  });
  assert.equal(status, 201);
  assert.equal(json.user.role, 'customer');
});

test('RBAC: customer no accede a /api/metrics (403), sin token 401, admin sí (200)', async () => {
  const loginCust = await api('POST', '/api/auth/login', { body: { email: 'cust@test.local', password: 'CustPass123!' } });
  assert.equal(loginCust.status, 200);
  const custToken = loginCust.json.token;
  assert.ok(custToken);

  const noAuth = await api('GET', '/api/metrics');
  assert.equal(noAuth.status, 401);

  const asCust = await api('GET', '/api/metrics', { token: custToken });
  assert.equal(asCust.status, 403);

  const custUpload = await api('POST', '/api/uploads', { token: custToken, body: {} });
  assert.equal(custUpload.status, 403);

  const loginAdmin = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(loginAdmin.status, 200, 'admin seed login OK');
  const adminToken = loginAdmin.json.token;

  const asAdmin = await api('GET', '/api/metrics', { token: adminToken });
  assert.equal(asAdmin.status, 200);
  assert.ok(typeof asAdmin.json.by_pickup_day === 'object' && asAdmin.json.by_pickup_day !== null);
  assert.ok(!('undefined' in asAdmin.json.by_pickup_day), 'sin clave undefined en by_pickup_day');
});

test('login con password incorrecta → 401', async () => {
  const { status } = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong-password' } });
  assert.equal(status, 401);
});
