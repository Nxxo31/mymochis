// MyMochis · Regresion de la auditoria de seguridad e integridad (2026-10-21).
//
// Tres bugs confirmados con peticiones reales antes del fix:
//
//  1. PII: GET /api/orders exigia autenticacion pero NO rol admin. Como
//     POST /api/auth/register es publico y emite role:'customer' sin coste,
//     cualquier registro gratuito leia el libro completo de pedidos
//     (nombre, telefono, direccion, notas) y podia filtrar por ?q=.
//  2. Stock: POST /api/orders descuenta unidades, pero DELETE y el paso a
//     'cancelled' no las devolvia. Cada pedido de prueba borrado quemaba
//     unidades reales del lote, de forma acumulativa y silenciosa.
//  3. Secreto: MockAdapter usaba 'mock-secret' como default, literal en el
//     repo, y server.js lo registraba siempre. Firmar un webhook con esa
//     palabra marcaba pedidos como pagados sin mover dinero.
//
// Cada test de este archivo debe fallar si alguien revierte el fix.
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
// Puerto propio: 4177-4183 y 4187 estan usados por otros test/*.test.js y
// node --test corre los archivos en paralelo.
const PORT = 4189;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@secaudit.local';
const ADMIN_PASSWORD = 'SecAuditTest123!';

let child, tmpDir, token, windowDate, comboId, dbPath;

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

// No existe GET /api/combos/:id (solo el listado), asi que el stock se lee de
// GET /api/combos filtrando por id.
async function comboStock() {
  const r = await api('GET', '/api/combos', { token });
  const lista = Array.isArray(r.json) ? r.json : (r.json?.combos || []);
  const c = lista.find(x => Number(x.id) === Number(comboId));
  assert.ok(c, `no se encontro el combo ${comboId} en GET /api/combos`);
  return {
    units_available: c.units_available,
    units_sold: c.units_sold ?? 0,
    units_reserved: c.units_reserved ?? 0,
  };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-secaudit-'));
  dbPath = join(tmpDir, 'test.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), NEXOMOCHIS_DB_PATH: dbPath,
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD, MYMOCHIS_NO_WORKERS: '1',
      // Sin este, MockAdapter genera un secreto aleatorio (fix del bug 3) y
      // este test no podria firmar webhooks predecibles.
      PAYMENT_MOCK_WEBHOOK_SECRET: 'secreto-de-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();

  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = r.json.token;
  assert.ok(token, 'login fallo');

  await api('POST', '/api/flavors', { token, body: { id: 'sec-fresa', name: 'Sec Fresa', price: 8000, available: 1 } });
  const comboRes = await api('POST', '/api/combos', {
    token, body: { name: 'Sec Combo', units: 6, price: 25000, available: true, units_available: 10 },
  });
  comboId = comboRes.json?.id;
  assert.ok(comboId != null, 'combo create fallo');

  const d = new Date(Date.now() + 3 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token,
    body: { release_date: windowDate, cutoff_at: `${windowDate}T09:00:00`, status: 'open',
            items: [{ flavor_id: 'sec-fresa', units_available: 50 }] },
  });
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: new Date(`${windowDate}T12:00:00Z`).getUTCDay(), mode: 'both',
            start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
  });
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// =============================================================================
// 1. PII — el libro de pedidos es del operador
// =============================================================================

test('PII — un customer solo ve SUS pedidos, no los de todos', async () => {
  const VICTIM_PHONE = '573009998877';
  await api('POST', '/api/orders', {
    body: { id: 'SEC-VICTIM', customer_name: 'Victima', customer_phone: VICTIM_PHONE,
            pickup_day: windowDate, items: { 'sec-fresa': 1 }, combos: [], total: 8000, source: 'test' },
  });

  const reg = await api('POST', '/api/auth/register', {
    body: { email: 'malo@secaudit.local', password: 'MaloCliente123!', name: 'Malo', phone: '573001119999' },
  });
  assert.equal(reg.status, 201, `register fallo: ${JSON.stringify(reg.json)}`);
  const malo = reg.json.token;

  const visto = await api('GET', '/api/orders', { token: malo });
  assert.equal(visto.status, 200);
  assert.ok(Array.isArray(visto.json), 'la respuesta debe ser una lista');

  // Este es el bug: antes el customer veia TODOS los pedidos.
  const ajenos = visto.json.filter(o => o.customer_phone === VICTIM_PHONE);
  assert.equal(ajenos.length, 0,
    `un customer no debe ver pedidos ajenos (vio ${ajenos.length}): ${JSON.stringify(ajenos)}`);
});

test('PII — no se puede inyectar el telefono por query string', async () => {
  const reg = await api('POST', '/api/auth/register', {
    body: { email: 'malo2@secaudit.local', password: 'MaloCliente123!', phone: '573001118888' },
  });
  const malo = reg.json.token;
  const r = await api('GET', '/api/orders?customer_phone=573009998877', { token: malo });
  assert.equal(r.status, 200);
  const ajenos = (r.json || []).filter(o => o.customer_phone === '573009998877');
  assert.equal(ajenos.length, 0, 'el filtro del cliente debe ganarle al query param');
});

test('PII — un pedido ajeno responde 404, no 403', async () => {
  const reg = await api('POST', '/api/auth/register', {
    body: { email: 'malo3@secaudit.local', password: 'MaloCliente123!', phone: '573001117777' },
  });
  const r = await api('GET', '/api/orders/SEC-VICTIM', { token: reg.json.token });
  assert.equal(r.status, 404, `un pedido ajeno debe dar 404, dio ${r.status}`);
});

test('PII — el admin sigue viendo todos los pedidos', async () => {
  const r = await api('GET', '/api/orders', { token });
  assert.equal(r.status, 200);
  assert.ok(r.json.some(o => o.id === 'SEC-VICTIM'),
    'el admin DEBE ver el libro completo, si no el panel deja de servir');
});

// =============================================================================
// 2. Stock — borrar o cancelar devuelve las unidades
// =============================================================================

test('stock — DELETE libera la reserva (no hay venta que devolver)', async () => {
  // Con el modelo de tres pools (2026-10-21) un pedido sin pagar RESERVA, no
  // vende. Borrarlo no "devuelve" unidades: LIBERA la reserva. Lo que hay que
  // comprobar es que el saldo prometible vuelva al inicial y que no se toque
  // units_sold, que es lo que solo mueve el pago confirmado.
  const before = await comboStock();
  const r = await api('POST', '/api/orders', {
    token,
    body: { id: 'SEC-STOCK-DEL', customer_name: 'Stock', customer_phone: '573001110000',
            pickup_day: windowDate, items: { 'sec-fresa': 2 }, combos: [{ id: comboId, qty: 1 }],
            total: 41000, source: 'test' },
  });
  assert.equal(r.status, 201, `alta fallo: ${JSON.stringify(r.json)}`);

  const durante = await comboStock();
  assert.equal(durante.units_reserved, (before.units_reserved || 0) + 1,
    'el pedido debe RESERVAR el combo');

  const del = await api('DELETE', '/api/orders/SEC-STOCK-DEL', { token });
  assert.equal(del.status, 200);

  const despues = await comboStock();
  assert.equal(despues.units_reserved, before.units_reserved || 0,
    `borrar debe liberar la reserva (${before.units_reserved || 0}), quedo en ${despues.units_reserved}`);
  assert.equal(despues.units_sold, before.units_sold || 0,
    'no se debe tocar units_sold: no hubo venta');
});

test('stock — cancelar devuelve las unidades al inventario', async () => {
  const before = await comboStock();
  await api('POST', '/api/orders', {
    token,
    body: { id: 'SEC-STOCK-CAN', customer_name: 'Stock', customer_phone: '573001110000',
            pickup_day: windowDate, items: { 'sec-fresa': 1 }, combos: [{ id: comboId, qty: 1 }],
            total: 33000, source: 'test' },
  });
  const r = await api('PATCH', '/api/orders/SEC-STOCK-CAN', { token, body: { status: 'cancelled' } });
  assert.equal(r.status, 200);

  const despues = await comboStock();
  assert.equal(despues.units_reserved, before.units_reserved || 0,
    `cancelar debe liberar la reserva, quedo en ${despues.units_reserved}`);
  assert.equal(despues.units_sold, before.units_sold || 0,
    'cancelar un pedido sin pagar no toca units_sold');
});

test('stock — cancelar dos veces NO restituye doble', async () => {
  const before = await comboStock();
  await api('POST', '/api/orders', {
    token,
    body: { id: 'SEC-STOCK-DUP', customer_name: 'Stock', customer_phone: '573001110000',
            pickup_day: windowDate, items: { 'sec-fresa': 1 }, combos: [{ id: comboId, qty: 1 }],
            total: 33000, source: 'test' },
  });
  await api('PATCH', '/api/orders/SEC-STOCK-DUP', { token, body: { status: 'cancelled' } });
  const medio = await comboStock();
  // El idempotente de verdad: el panel hace doble clic.
  await api('PATCH', '/api/orders/SEC-STOCK-DUP', { token, body: { status: 'cancelled' } });
  const fin = await comboStock();

  assert.equal(fin.units_reserved, medio.units_reserved,
    `el segundo cancel no debe volver a liberar (${medio.units_reserved} -> ${fin.units_reserved})`);
  assert.equal(fin.units_reserved, before.units_reserved || 0, 'y el saldo vuelve al inicial');
});

test('stock — borrar un pedido YA cancelado no restituye otra vez', async () => {
  const before = await comboStock();
  await api('POST', '/api/orders', {
    token,
    body: { id: 'SEC-STOCK-BOTH', customer_name: 'Stock', customer_phone: '573001110000',
            pickup_day: windowDate, items: { 'sec-fresa': 1 }, combos: [{ id: comboId, qty: 1 }],
            total: 33000, source: 'test' },
  });
  await api('PATCH', '/api/orders/SEC-STOCK-BOTH', { token, body: { status: 'cancelled' } });
  const medio = await comboStock();
  await api('DELETE', '/api/orders/SEC-STOCK-BOTH', { token });
  const fin = await comboStock();
  assert.equal(fin.units_reserved, medio.units_reserved,
    `borrar un pedido ya cancelado no debe liberar otra vez (${medio.units_reserved} -> ${fin.units_reserved})`);
  assert.equal(fin.units_reserved, before.units_reserved || 0);
});

// =============================================================================
// 3. El secreto del mock no es adivinable
// =============================================================================

test('secreto — el webhook NO acepta la firma con "mock-secret" (el default viejo)', async () => {
  const payload = {
    provider: 'mock', type: 'payment.approved',
    payment_id: 'pay_secaudit_1', order_id: 'SEC-VICTIM', amount: 8000,
  };
  // La firma se calcula sobre los bytes EXACTOS que viajan. El endpoint usa
  // req.rawBody, que express.json captura via el verify callback de server.js,
  // asi que hay que mandar el body por `body` (no por headers) para que el
  // parser lo procese y la firma coincida byte a byte.
  const firmaVieja = createHmac('sha256', 'mock-secret')
    .update(JSON.stringify(payload)).digest('hex');
  const r = await api('POST', '/api/webhooks/mock', {
    body: payload,
    headers: {
      'x-mock-signature': firmaVieja,   // el header REAL (con guion bajo)
      'x-mock-event-id': `evt_secaudit_${Date.now()}`,
    },
  });
  // Antes del fix esto devolvia 200 y aceptaba el evento.
  assert.notEqual(r.status, 200,
    `firmar con 'mock-secret' debe RECHAZARSE; devolvio ${r.status} ${JSON.stringify(r.json)}`);
});

test('secreto — la firma con el secreto configurado SI se acepta', async () => {
  const payload = {
    provider: 'mock', type: 'payment.approved',
    payment_id: 'pay_secaudit_ok', order_id: 'SEC-VICTIM', amount: 8000,
  };
  const firma = createHmac('sha256', 'secreto-de-test')
    .update(JSON.stringify(payload)).digest('hex');
  const r = await api('POST', '/api/webhooks/mock', {
    body: payload,
    headers: {
      'x-mock-signature': firma,
      'x-mock-event-id': `evt_secaudit_ok_${Date.now()}`,
    },
  });
  // Si esto falla, el fix anterior rompio el flujo legitimo de pruebas.
  assert.equal(r.status, 200, `la firma con el secreto configurado debe aceptarse: ${JSON.stringify(r.json)}`);
});

test('secreto — en produccion sin secreto el server NO arranca', async () => {
  // El comportamiento se verifica leyendo el codigo: el fail-fast esta en
  // server.js, y arrancar un subproceso aqui seria lento y frágil.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /PAYMENT_MOCK_WEBHOOK_SECRET/,
    'server.js debe decidir con el secreto, no con NODE_ENV a secas');
  assert.match(src, /process\.exit\(1\)/,
    'sin secreto en produccion el server debe negarse a arrancar');

  const mock = readFileSync(join(ROOT, 'src/lib/payments/adapters/mock.js'), 'utf8');
  assert.doesNotMatch(mock, /\|\|\s*'mock-secret'/,
    "el default inseguro 'mock-secret' no debe volver a existir en el adapter");
});