// MyMochis · Modelo de tres pools de stock: disponible / reservado / vendido.
//
// Por que existe (2026-10-21): el negocio cobra por transferencia manual. Entre
// que el cliente pide y que el operador confirma el pago hay horas. Con dos
// contadores (units_available vs units_sold) un pedido que NUNCA se pagaba
// bloqueaba stock igual que uno pagado, y el operador terminaba produciendo
// para pedidos fantasma mientras la app decia "agotado".
//
// Decidido con el operador:
//   - pedir RESERVA, vender es CONFIRMAR EL PAGO
//   - la reserva NO expira sola: si el cliente no paga, el stock queda retenido
//     hasta que el operador libere el pedido cancelandolo
//
// Invariante: disponible - reservado - vendido = lo que se puede prometer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4191;   // libre: 4177-4187, 4189, 4190 ya usados
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@stock3.local';
const ADMIN_PASSWORD = 'Stock3Test123!';

let child, tmpDir, token, windowDate, comboId, flavorId;

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('server did not start');
}

async function api(method, path, { token: t, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (t) h['Authorization'] = `Bearer ${t}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** Los tres contadores de un combo. */
async function pools() {
  const r = await api('GET', '/api/combos', { token });
  const lista = Array.isArray(r.json) ? r.json : (r.json?.combos || []);
  const c = lista.find(x => Number(x.id) === Number(comboId));
  assert.ok(c, `no se encontro el combo ${comboId}`);
  return { reserved: c.units_reserved || 0, sold: c.units_sold || 0, remaining: c.stock_remaining };
}

let n = 0;
const uniq = () => `S3-${Date.now().toString(36)}-${n++}`;

function nuevoPedido(id, qty) {
  return api('POST', '/api/orders', {
    token,
    body: {
      id, customer_name: 'Stock3', customer_phone: '573001110000',
      pickup_day: windowDate, items: { [flavorId]: 2 },
      combos: [{ id: comboId, qty }], total: 41000, source: 'test',
    },
  });
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-stock3-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD, MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = r.json.token;
  assert.ok(token, 'login fallo');

  flavorId = 's3-fresa';
  await api('POST', '/api/flavors', { token, body: { id: flavorId, name: 'S3 Fresa', price: 8000, available: 1 } });
  const comboRes = await api('POST', '/api/combos', {
    token, body: { name: 'S3 Combo', units: 6, price: 25000, available: true, units_available: 20 },
  });
  comboId = comboRes.json?.id;
  assert.ok(comboId != null, 'combo create fallo');

  // Domingo: el unico dia sin horario de la plantilla mar-sab, asi que el
  // test no depende de que haya schedule para un dia especifico.
  const d = new Date(Date.now() + 4 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token,
    body: { release_date: windowDate, cutoff_at: `${windowDate}T09:00:00`, status: 'open',
            items: [{ flavor_id: flavorId, units_available: 100 }] },
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

test('pedir RESERVA stock, no lo VENDE', async () => {
  const antes = await pools();
  const r = await nuevoPedido(uniq(), 2);
  assert.equal(r.status, 201, `pedido fallo: ${JSON.stringify(r.json)}`);

  const depues = await pools();
  assert.equal(depues.reserved, antes.reserved + 2, 'las unidades deben quedar reservadas');
  assert.equal(depues.sold, antes.sold, 'un pedido SIN pagar no puede contar como vendido');
  assert.equal(depues.remaining, antes.remaining - 2,
    `el saldo prometible debe bajar 2: ${antes.remaining} -> ${depues.remaining}`);
});

test('confirmar el pago convierte la reserva en venta', async () => {
  const antes = await pools();
  const id = uniq();
  await nuevoPedido(id, 3);

  const conReserva = await pools();
  assert.equal(conReserva.reserved, antes.reserved + 3, 'primero reserva');

  const cf = await api('POST', `/api/orders/${id}/confirm-payment`, { token, body: { reference: 'S3-REF' } });
  assert.equal(cf.status, 201, `confirmacion fallo: ${JSON.stringify(cf.json)}`);

  const venta = await pools();
  assert.equal(venta.reserved, antes.reserved, 'la reserva debe quedar en 0 tras vender');
  assert.equal(venta.sold, antes.sold + 3, 'las unidades deben pasar a vendidas');
  assert.equal(venta.remaining, antes.remaining - 3, 'el saldo no cambia: lo prometido se cumple');
});

test('confirmar dos veces no vuelve a descontar', async () => {
  const antes = await pools();
  const id = uniq();
  await nuevoPedido(id, 1);
  await api('POST', `/api/orders/${id}/confirm-payment`, { token, body: { reference: 'S3-REF2' } });

  const trasPago = await pools();
  const otra = await api('POST', `/api/orders/${id}/confirm-payment`, { token, body: { reference: 'S3-REF2' } });
  assert.equal(otra.status, 200);
  assert.equal(otra.json.already_confirmed, true, 'debe reportarse como ya confirmado');

  const fin = await pools();
  assert.equal(fin.sold, trasPago.sold, 'la segunda confirmacion no debe vender de nuevo');
  assert.equal(fin.reserved, trasPago.reserved);
});

test('cancelar un pedido SIN pagar LIBERA la reserva y no toca la venta', async () => {
  const antes = await pools();
  const id = uniq();
  await nuevoPedido(id, 2);

  const conReserva = await pools();
  assert.equal(conReserva.reserved, antes.reserved + 2);

  const r = await api('PATCH', `/api/orders/${id}`, { token, body: { status: 'cancelled' } });
  assert.equal(r.status, 200);

  const fin = await pools();
  assert.equal(fin.reserved, antes.reserved, 'la reserva debe liberarse');
  assert.equal(fin.sold, antes.sold, 'NO hay venta que devolver: el pedido nunca se pago');
});

test('el saldo prometible descuenta lo reservado por pedidos sin pagar', async () => {
  // Es el punto del modelo: lo reservado NO esta disponible para otro cliente.
  const antes = await pools();
  await nuevoPedido(uniq(), 4);           // queda reservado, sin pagar
  const conReserva = await pools();

  assert.equal(conReserva.remaining, antes.remaining - 4,
    'un pedido sin pagar debe reducir lo que se puede prometer');

  // Y /api/public/ (lo que ve el cliente) debe reportar lo mismo.
  const cat = await api('GET', '/api/public/');
  const w = cat.json.release_windows.find(x => x.release_date === windowDate);
  assert.ok(w, 'la ventana debe estar en el catalogo publico');
  const item = w.items.find(i => i.flavor_id === flavorId);
  assert.ok(item, 'el sabor debe estar en la ventana');
  assert.equal(typeof item.units_reserved, 'number', 'el catalogo debe exponer units_reserved');
  assert.equal(item.units_remaining,
    item.units_available - (item.units_sold || 0) - item.units_reserved,
    'units_remaining debe ser available - sold - reserved');
});

test('no se puede pedir mas que el saldo disponible (la reserva cuenta)', async () => {
  const antes = await pools();
  const r = await api('POST', '/api/orders', {
    token,
    body: { id: uniq(), customer_name: 'Stock3', customer_phone: '573001110000',
            pickup_day: windowDate, items: {}, combos: [{ id: comboId, qty: antes.remaining + 5 }],
            total: 999999, source: 'test' },
  });
  assert.equal(r.status, 409, `pedir mas del saldo debe fallar: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, 'combo_out_of_stock');

  const fin = await pools();
  assert.equal(fin.remaining, antes.remaining, 'el rechazo no debe mover nada');
});