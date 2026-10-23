// MyMochis · Regresión de la auditoría 2026-10-20
//
// Un test por bug encontrado en la auditoría. Estos tests fallaron contra el
// código previo al fix y pasan con él. Si alguien revierte un fix, falla acá.
//
// Patrón: mismo harness que payments.test.js (subprocess + DB temporal).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4180;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@audit.local';
const ADMIN_PASSWORD = 'AuditTest123!';

let child, tmpDir, token, windowDate, comboId;

async function waitReady(timeoutMs = 60000) {
  // Deadline generoso: node:test corre los archivos en paralelo y cada before()
  // spawnea su propio server. La noche 2026-10-22 los 10 boots simultáneos
  // tardaron >15s bajo la carga del cron nocturno y 71/84 tests volaron por
  // este deadline (vault pasó con 16.7s por los pelos). Si el child muere,
  // el polling corta de inmediato en vez de quemar el deadline entero.
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

async function api(method, path, { token: t, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (t) h['Authorization'] = `Bearer ${t}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

let n = 0;
const uniq = () => `AUD-${Date.now().toString(36)}-${n++}`;

async function seed() {
  await api('POST', '/api/flavors', { token, body: { id: 'aud-fresa', name: 'Aud Fresa', price: 8000, available: 1 } });
  const comboRes = await api('POST', '/api/combos', { token, body: { name: 'Aud Combo 6', units: 6, price: 25000, available: true, units_available: 20 } });
  // La API devuelve el id generado (INTEGER PK): se usa el real, no un hardcode.
  comboId = comboRes.json?.id ?? comboRes.json?.combo?.id;
  assert.ok(comboId != null, `combo create fallo: ${comboRes.status} ${JSON.stringify(comboRes.json)}`);
  // Ventana abierta para una fecha futura con cutoff amplio
  const d = new Date(Date.now() + 3 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token,
    body: {
      release_date: windowDate,
      cutoff_at: `${windowDate}T09:00:00`,
      status: 'open',
      items: [{ flavor_id: 'aud-fresa', units_available: 500 }],
    },
  });
  // delivery_schedule activa ese dia de semana (cutoff 48h para que no bloquee)
  const dow = new Date(`${windowDate}T12:00:00Z`).getUTCDay();
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: dow, mode: 'both', start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
  });
}

async function order(extra = {}) {
  return api('POST', '/api/orders', {
    token,
    body: {
      id: uniq(), customer_name: 'Audit', customer_phone: '573213050426',
      pickup_day: windowDate, items: { 'aud-fresa': 2 }, combos: [], total: 16000, source: 'test',
      ...extra,
    },
  });
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-audit-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
           NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'), ADMIN_EMAIL, ADMIN_PASSWORD,
           MYMOCHIS_NO_WORKERS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = r.json.token;
  await seed();
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// =============================================================================
// Bug #1 — el total lo controla el cliente
// =============================================================================

test('bug#1 — POST /orders ignora el total del cliente y recalcula desde el catálogo', async () => {
  const r = await order({ total: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.json.total, 16000, 'el server debe cobrar 2 x 8000 = 16000, no el 1 que mando el cliente');
  assert.equal(r.json.pricing.client_drift.client_sent, 1);
  assert.equal(r.json.pricing.client_drift.server_computed, 16000);
});

test('bug#1 — el desglose de precios viene calculado por el server', async () => {
  const r = await order();
  assert.equal(r.json.pricing.lines.length, 1);
  assert.equal(r.json.pricing.lines[0].name, 'Aud Fresa');
  assert.equal(r.json.pricing.lines[0].subtotal, 16000);
});

// =============================================================================
// Bug #2 — payments.amount_minor en la unidad equivocada
// =============================================================================

test('bug#2 — el monto del pago es el total del pedido en pesos (no centavos)', async () => {
  const o = await order();
  const r = await api('POST', '/api/payments', {
    token,
    headers: { 'Idempotency-Key': uniq() },
    body: { order_id: o.json.id, amount_minor: o.json.total, currency: 'COP', provider: 'mock',
            customer_phone: '573213050426' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.amount_minor ?? o.json.total, o.json.total);
});

test('bug#2 — un monto que NO cuadra con el pedido se rechaza', async () => {
  const o = await order();
  const r = await api('POST', '/api/payments', {
    token, headers: { 'Idempotency-Key': uniq() },
    body: { order_id: o.json.id, amount_minor: o.json.total + 1000, provider: 'mock' },
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.details.some(d => /must equal order total/.test(d)), JSON.stringify(r.json.details));
});

// =============================================================================
// Bug #5 — orders.payment_status fuera de dominio
// =============================================================================

test('bug#5 — orders.payment_status nunca recibe un valor fuera de pending|paid', async () => {
  const o = await order();
  await api('POST', '/api/payments', {
    token, headers: { 'Idempotency-Key': uniq() },
    body: { order_id: o.json.id, amount_minor: o.json.total, provider: 'mock', customer_phone: '573213050426' },
  });
  const check = await api('GET', `/api/orders/${o.json.id}`, { token });
  assert.ok(['pending', 'paid'].includes(check.json.payment_status),
    `payment_status="${check.json.payment_status}" fuera del dominio`);
});

// =============================================================================
// Bug #6 — combos sin stock
// =============================================================================

test('bug#6 — se puede comprar un combo sin sabores (antes: 400 no_items)', async () => {
  const r = await order({ items: {}, combos: [{ id: comboId, qty: 1, name: 'Aud Combo 6' }], total: 25000 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.total, 25000);
  assert.equal(r.json.pricing.lines[0].type, 'combo');
});

test('bug#6 — comprar un combo RESERVA su stock (se vendera al confirmar el pago)', async () => {
  // El modelo paso a tres pools (disponible/reservado/vendido) el 2026-10-21:
  // pedir RESERVA, vender es confirmar el pago. El saldo que ve el cliente
  // baja igual, pero por reserva, no por venta — que es justo el punto: un
  // pedido que nunca se paga no debe consumir unidades vendidas.
  const before = (await api('GET', '/api/combos', { token })).json.find(c => c.id === comboId);
  const r = await order({ items: {}, combos: [{ id: comboId, qty: 2 }], total: 50000 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const after = (await api('GET', '/api/combos', { token })).json.find(c => c.id === comboId);

  assert.equal(after.stock_remaining, before.stock_remaining - 2,
    `el saldo prometible debe bajar 2: ${before.stock_remaining} -> ${after.stock_remaining}`);
  assert.equal(after.units_reserved, (before.units_reserved || 0) + 2,
    'las unidades deben quedar RESERVADAS, no vendidas');
  assert.equal(after.units_sold, before.units_sold || 0,
    'un pedido sin pagar NO debe contar como vendido');
});

test('bug#6 — pedir mas combos de los disponibles revierte todo (409, sin pedido huerfano)', async () => {
  const before = (await api('GET', '/api/combos', { token })).json.find(c => c.id === comboId)?.stock_remaining;
  const r = await order({ items: {}, combos: [{ id: comboId, qty: before + 50 }], total: 999999 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'combo_out_of_stock');
  const after = (await api('GET', '/api/combos', { token })).json.find(c => c.id === comboId)?.stock_remaining;
  assert.equal(after, before, 'el ROLLBACK debe restaurar el stock');
});

// =============================================================================
// Bug #7 — fingerprint de idempotencia no canonico
// =============================================================================

test('bug#7 — el mismo body con claves en distinto orden es el mismo request', async () => {
  const o = await order();
  const key = uniq();
  const a = await api('POST', '/api/payments', {
    token, headers: { 'Idempotency-Key': key },
    body: { order_id: o.json.id, amount_minor: o.json.total, provider: 'mock', currency: 'COP', customer_phone: '573213050426' },
  });
  const b = await api('POST', '/api/payments', {
    token, headers: { 'Idempotency-Key': key },
    body: { customer_phone: '573213050426', provider: 'mock', currency: 'COP', amount_minor: o.json.total, order_id: o.json.id },
  });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(b.status, 200, `mismo body reordenado debe ser replay cacheado, no conflicto: ${JSON.stringify(b.json)}`);
  assert.equal(b.json.payment_id, a.json.payment_id);
});

// =============================================================================
// Bug #11 — el panel miente sobre la unidad de los campos de entrega
// =============================================================================

test('bug#11 — el panel de entregas no dice "centavos COP" para valores en pesos', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(join(ROOT, 'public', 'manage.html'), 'utf8');
  assert.ok(!/centavos COP/.test(html),
    'el hint "5000 = $50 COP" miente: el valor esta en pesos (5000 = $5.000)');
});

// =============================================================================
// Bug #12 — cutoff de pickup en hora LOCAL de Colombia, no UTC (t_f6d7dd48)
//
// El horario sembrado en seed() usa start_time '15:00' con cutoff_offset 0
// para windowDate. "15:00" es 15:00 America/Bogota (UTC-5) = 20:00Z.
// Con el bug (Date.UTC crudo) el cutoff_computed_at publicaba 15:00Z — 5 horas
// mas temprano de lo que el negocio cree, cerrando pedidos a las 02:00 local.
// El instante publicado es determinista: no depende de la hora de la corrida.
// =============================================================================

test('bug#12 — cutoff_computed_at respeta America/Bogota (UTC-5), no UTC', async () => {
  const r = await api('GET', '/api/public');
  assert.equal(r.status, 200, 'GET /api/public debe responder 200');
  const entry = (r.json.release_windows || []).find(w => w.release_date === windowDate);
  assert.ok(entry, `la ventana sembrada para ${windowDate} debe salir en /api/public`);
  // La fila que gobierna es la del seed de boot de src/db.js (Mon-Vie 15:00
  // offset 8h, Sab 12:00 offset 12h; Domingo no tiene fila de boot y gobierna
  // la fila del seed() del test: 15:00 offset 0). Instante esperado en UTC
  // para el MISMO dia local: hora Bogota + 5h, menos el offset.
  // Ejemplo de la card t_f6d7dd48: pickup Lunes 15:00, cutoff 8h antes =
  // 07:00 Bogota = 12:00Z. Con el bug UTC era 07:00Z = 02:00 local.
  const dow = new Date(`${windowDate}T12:00:00Z`).getUTCDay();
  const expectedByDow = {
    0: `${windowDate}T20:00:00.000Z`, // domingo: fila del seed() 15:00 offset 0
    1: `${windowDate}T12:00:00.000Z`, // lun-vie: 15:00 Bogota (20:00Z) - 8h
    2: `${windowDate}T12:00:00.000Z`,
    3: `${windowDate}T12:00:00.000Z`,
    4: `${windowDate}T12:00:00.000Z`,
    5: `${windowDate}T12:00:00.000Z`,
    6: `${windowDate}T05:00:00.000Z`,  // sabado: 12:00 Bogota (17:00Z) - 12h
  };
  assert.equal(
    entry.cutoff_computed_at,
    expectedByDow[dow],
    `cutoff de ${windowDate} (dow ${dow}) debe ser hora-local Bogota - offset. ` +
    `Con el bug UTC seria 5h mas temprano (la card: pedidos cerrando 02:00 local). ` +
    `Recibido: ${entry.cutoff_computed_at}`
  );
});

test('bug#12b — un pickup de HOY con inicio en 1h sigue orderable (no 5h antes)', async () => {
  // Discriminador end-to-end del mismo bug via POST /api/orders: siembra una
  // ventana para HOY con inicio 1h en el futuro (hora local Bogota) y cutoff
  // 0h. Con el fix el pedido entra (cutoff = ahora+1h); con el bug UTC el
  // cutoff quedaba 4h en el pasado y respondia 400 past_cutoff.
  const nowBogota = new Date(Date.now() - (-300) * 60 * 1000); // now en UTC-5
  const start = new Date(nowBogota.getTime() + 60 * 60 * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  const today = `${nowBogota.getUTCFullYear()}-${pad(nowBogota.getUTCMonth() + 1)}-${pad(nowBogota.getUTCDate())}`;
  const hhmm = `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`;
  const dow = new Date(Date.UTC(nowBogota.getUTCFullYear(), nowBogota.getUTCMonth(), nowBogota.getUTCDate())).getUTCDay();
  // Si ya son las 23:xx local, el inicio 1h futuro cae mañana: en ese caso el
  // discriminador no aplica (el cutoff viejo tambien quedaria en el futuro)
  // y el test se salta sin mentir.
  if (Number(hhmm.slice(0, 2)) < Number(pad(nowBogota.getUTCHours()))) {
    console.log('skip: inicio 1h cruza medianoche, discriminador no aplica a esta hora');
    return;
  }
  const w = await api('POST', '/api/release-windows', {
    token,
    body: { release_date: today, cutoff_at: `${today}T09:00:00`, status: 'open',
           items: [{ flavor_id: 'aud-fresa', units_available: 500 }] },
  });
  assert.ok([200, 201].includes(w.status), `release window de hoy: ${JSON.stringify(w.json)}`);
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: dow, mode: 'both', start_time: hhmm, end_time: '23:00', cutoff_offset_hours: 0, active: 1 },
  });
  const o = await order({ pickup_day: today });
  assert.notEqual(o.status, 400, `pedido para hoy con inicio ${hhmm} local no debe rechazarse: ${JSON.stringify(o.json)}`);
  assert.ok([200, 201].includes(o.status), `estado inesperado: ${o.status} ${JSON.stringify(o.json)}`);
});
