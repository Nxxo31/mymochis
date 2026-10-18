import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Tests del flujo multi-número (order_recipients) + multi-admin (POST /api/users)
// + dispatch round-robin del POST /api/orders. Puerto propio para no chocar
// con test/api.test.js (el runner ejecuta archivos en paralelo).

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4178;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@multi.test';
const ADMIN_PASSWORD = 'AdminMulti123!';

let child;
let tmpDir;
let adminToken = null;

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

function spawnServer(extraEnv = {}) {
  return spawn(process.execPath, ['server.js'], {
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
      ...extraEnv,
    },
    stdio: 'ignore',
  });
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

// Próxima fecha con día de semana en [1..6] (Lun–Sáb) al menos 2 días adelante,
// para que el cutoff (pickup - 8h) nunca haya pasado.
function nextPickupDate() {
  const now = new Date();
  for (let add = 2; add <= 9; add++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add));
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 6) return d.toISOString().slice(0, 10);
  }
  throw new Error('no pickup date found');
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-multi-'));
  child = spawnServer();
  await waitReady();
  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, 'admin seed login');
  adminToken = login.json.token;
});

after(async () => {
  if (child) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('recipients: RBAC + CRUD básico', async () => {
  const noToken = await api('GET', '/api/recipients');
  assert.equal(noToken.status, 401);

  const reg = await api('POST', '/api/auth/register', { body: { email: 'cust@multi.test', password: 'CustPass123!', name: 'Cust' } });
  assert.equal(reg.status, 201);
  const custLogin = await api('POST', '/api/auth/login', { body: { email: 'cust@multi.test', password: 'CustPass123!' } });
  const custToken = custLogin.json.token;
  const asCust = await api('GET', '/api/recipients', { token: custToken });
  assert.equal(asCust.status, 403);

  const badPhone = await api('POST', '/api/recipients', { token: adminToken, body: { label: 'X', phone: '123' } });
  assert.equal(badPhone.status, 400);

  const r1 = await api('POST', '/api/recipients', { token: adminToken, body: { label: 'Admin Uno', phone: '573001111111' } });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.phone, '573001111111');
  const r2 = await api('POST', '/api/recipients', { token: adminToken, body: { label: 'Admin Dos', phone: '+57 300 222 2222' } });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.phone, '573002222222', 'normaliza no-dígitos');

  const dup = await api('POST', '/api/recipients', { token: adminToken, body: { label: 'Otro', phone: '573001111111' } });
  assert.equal(dup.status, 409);

  const list = await api('GET', '/api/recipients', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.json.recipients.length, 2);
});

test('multi-admin: admin crea otro admin y sobrevive reinicio', async () => {
  const weak = await api('POST', '/api/users', { token: adminToken, body: { email: 'admin2@multi.test', password: 'short', role: 'admin' } });
  assert.equal(weak.status, 400);

  const created = await api('POST', '/api/users', { token: adminToken, body: { name: 'Admin Dos', email: 'admin2@multi.test', password: 'AdminDos123!', role: 'admin' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.role, 'admin');

  // Un customer no puede crear admins
  const custLogin = await api('POST', '/api/auth/login', { body: { email: 'cust@multi.test', password: 'CustPass123!' } });
  const asCust = await api('POST', '/api/users', { token: custLogin.json.token, body: { email: 'x@multi.test', password: 'Whatever123', role: 'admin' } });
  assert.equal(asCust.status, 403);

  // El nuevo admin entra y accede a métricas
  const login2 = await api('POST', '/api/auth/login', { body: { email: 'admin2@multi.test', password: 'AdminDos123!' } });
  assert.equal(login2.status, 200, 'nuevo admin puede loguearse');
  const metrics = await api('GET', '/api/metrics', { token: login2.json.token });
  assert.equal(metrics.status, 200, 'nuevo admin ve métricas');

  // Reinicio del server: el rol admin NO se demuele (fix 2026-10-17)
  child.kill();
  await new Promise(r => child.once('exit', r));
  child = spawnServer();
  await waitReady();
  const relogin = await api('POST', '/api/auth/login', { body: { email: 'admin2@multi.test', password: 'AdminDos123!' } });
  assert.equal(relogin.status, 200, 'admin2 sigue siendo admin tras reinicio');
  const metrics2 = await api('GET', '/api/metrics', { token: relogin.json.token });
  assert.equal(metrics2.status, 200);

  // restaurar token del admin principal (sigue válido: JWT firmado igual)
  const loginA = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  adminToken = loginA.json.token;
});

test('flujo negocio: pedido web → dashboard + deep-link round-robin', async () => {
  // Catálogo + ventana de release para la fecha de recogida
  const flavor = await api('POST', '/api/flavors', { token: adminToken, body: { id: 'test-sabor', name: 'Sabor de prueba', price: 8000, available: true } });
  assert.ok([201, 409].includes(flavor.status), 'flavor creado o ya existente');

  const pickupDate = nextPickupDate();
  const win = await api('POST', '/api/release-windows', {
    token: adminToken,
    body: { release_date: pickupDate, cutoff_at: `${pickupDate}T07:00:00`, status: 'open', items: [{ flavor_id: 'test-sabor', units_available: 50 }] }
  });
  assert.ok([201, 409].includes(win.status), 'release window creada');

  const primaries = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/orders', {
      body: {
        id: `MYM-TEST${i}${Date.now().toString(36).toUpperCase()}`,
        customer_name: `Cliente Prueba ${i}`,
        customer_phone: '573005551234',
        pickup_day: pickupDate,
        items: { 'test-sabor': 1 },
        combos: [],
        total: 8000,
        source: 'web'
      }
    });
    assert.equal(r.status, 201, `order ${i} creada`);
    const wsp = r.json.whatsapp;
    assert.ok(wsp, 'respuesta incluye whatsapp');
    assert.ok(wsp.deep_link && wsp.deep_link.startsWith('https://api.whatsapp.com/send/'), 'deep_link presente (api.whatsapp.com preserva emojis)');
    assert.equal(wsp.recipients_count, 2, 'broadcast a los 2 destinatarios');
    assert.equal(wsp.cloud_status, 'skipped', 'cloud sin credenciales → skipped');
    primaries.push(wsp.primary_phone);

    // El mensaje viaja en el deep-link: verificar contenido clave
    const text = decodeURIComponent(new URL(wsp.deep_link).searchParams.get('text') || '');
    assert.ok(text.includes(r.json.id), 'mensaje incluye # de pedido');
    assert.ok(text.includes('$8.000'), `mensaje muestra total en pesos COP (recibido: ${text.match(/\$[\d.,]+/)?.[0]})`);
    assert.ok(text.includes('Sabor de prueba'), 'mensaje incluye el nombre del sabor');
    assert.ok(text.includes('panel MyMochis'), 'mensaje avisa registro en panel');
  }

  // Round-robin: 3 pedidos entre 2 números → alternancia, nunca dos iguales seguidos
  assert.notEqual(primaries[0], primaries[1], 'pedido 1 y 2 van a números distintos');
  assert.equal(primaries[0], primaries[2], 'pedido 3 vuelve al primer número');
  assert.ok(['573001111111', '573002222222'].includes(primaries[0]), 'número del pool');

  // Los pedidos quedaron en el dashboard (lista admin)
  const orders = await api('GET', '/api/orders', { token: adminToken });
  assert.equal(orders.status, 200);
  assert.ok(orders.json.length >= 3, 'dashboard lista los pedidos');
  assert.ok(orders.json.some(o => o.customer_name === 'Cliente Prueba 2'));

  // Métricas los computan
  const metrics = await api('GET', '/api/metrics', { token: adminToken });
  assert.equal(metrics.status, 200);
  assert.ok(metrics.json.totals.count >= 3, 'métricas cuentan los pedidos');
  assert.ok(metrics.json.totals.gross >= 24000, 'gross acumula los totales en pesos');
});

test('pausar un número lo saca de la rotación', async () => {
  const list = await api('GET', '/api/recipients', { token: adminToken });
  const first = list.json.recipients[0];
  const paused = await api('PATCH', `/api/recipients/${first.id}`, { token: adminToken, body: { active: 0 } });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.active, 0);

  const pickupDate = nextPickupDate();
  const r = await api('POST', '/api/orders', {
    body: {
      id: `MYM-PAUSE${Date.now().toString(36).toUpperCase()}`,
      customer_name: 'Cliente Pausa',
      customer_phone: '573005551234',
      pickup_day: pickupDate,
      items: { 'test-sabor': 1 },
      combos: [],
      total: 8000,
      source: 'web'
    }
  });
  assert.equal(r.status, 201);
  assert.notEqual(r.json.whatsapp.primary_phone, first.phone, 'el número pausado no recibe pedidos');
  assert.equal(r.json.whatsapp.recipients_count, 1, 'solo el activo queda en el pool');

  await api('PATCH', `/api/recipients/${first.id}`, { token: adminToken, body: { active: 1 } });
});
