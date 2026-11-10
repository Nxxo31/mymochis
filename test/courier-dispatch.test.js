// MyMochis · Motor de reparto y portal del domiciliario (spec 57, r1/r2/r3/r8/r9).
//
// Contrato que queda fijado aqui:
//
//   - el admin crea el domiciliario y su cuenta de portal (rol 'courier')
//   - el pedido de domicilio (delivery_mode='immediate') recibe un reparto
//     automatico: el de MENOS carga activa, desempate por distancia
//   - sin domiciliario elegible NO se asigna a nadie (fail-closed) y el pedido
//     del cliente NO falla: queda en la cola para que el admin lo asigne
//   - el domiciliario solo ve SU cola y solo mueve SUS repartos
//   - la maquina de estados es assigned -> picked_up -> on_way -> delivered/failed
//     y es idempotente
//   - confirmar el cobro contra entrega es idempotente y deja el pedido pagado
//   - el precio de recogida del domiciliario tiene piso de margen (% sobre el
//     costo y/o minimo por pedido) y queda CONGELADO al asignar el reparto
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
const PORT = 4194;   // libre: 4177-4181, 4183, 4185, 4187, 4189, 4191-4193, 4195, 4197, 4199, 4201
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@courier.local';
const ADMIN_PASSWORD = 'CourierAdmin123!';

const ADDRESS = 'Calle 10 #5-20, Neiva';
const ZONE = { lat: 2.927, lng: -75.289 };

let child, tmpDir, token, dbPath;
let dateSabado, flavorId;
let courierA, courierB, courierC, courierD;

const LEJOS = 'Calle 20 #10-30, Neiva';

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

async function api(method, path, { token: t, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (t) h['Authorization'] = `Bearer ${t}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function proximoDia(dow) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const cand = new Date(d.getTime() + i * 86400000);
    if (cand.getUTCDay() === dow) return cand.toISOString().slice(0, 10);
  }
  throw new Error(`no se encontro un ${dow}`);
}

let n = 0;
const uniq = () => `CD-${Date.now().toString(36)}-${n++}`;

function pedidoDomicilio(id) {
  return api('POST', '/api/orders', {
    body: {
      id, customer_name: 'Cliente Domicilio', customer_phone: '573001220000',
      pickup_day: dateSabado, items: { [flavorId]: 1 }, combos: [],
      total: 8000, source: 'test',
      delivery_mode: 'immediate', delivery_address: ADDRESS,
    },
  });
}

function crearDomiciliario(body) {
  return api('POST', '/api/couriers', { token, body });
}

// El servidor usa Nominatim para geocodificar, asi que las direcciones del
// test se precargan en la cache (como hace el before).
function cacheAddress(raw, lat, lng) {
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(raw_address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng
  `).run(raw, lat, lng, 'Neiva, Huila');
  db.close();
}

async function colaDe(email, password) {
  const login = await api('POST', '/api/courier/login', { body: { email, password } });
  const cola = await api('GET', '/api/courier/queue', { token: login.json?.token });
  return cola.json?.dispatches || [];
}

// Stream de eventos (SSE, r11): abre la conexion y acumula los eventos que
// llegan. El token va en la query porque EventSource no manda headers.
async function openEventStream(jwt) {
  const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(jwt)}`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, 'el stream de eventos debe abrir');
  assert.ok(String(res.headers.get('content-type')).includes('text/event-stream'), 'la respuesta es SSE');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let corte;
        while ((corte = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, corte);
          buffer = buffer.slice(corte + 2);
          const tipo = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (tipo) events.push({ type: tipo, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      /* el cancel() del stop() corta el stream */
    }
  })();

  return {
    events,
    stop: async () => {
      try { await reader.cancel(); } catch {}
      await pump;
    },
  };
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const valor = fn();
    if (valor) return valor;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-courier-'));
  dbPath = join(tmpDir, 'test.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: dbPath,
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD, MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();

  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = login.json?.token;
  assert.ok(token, 'login fallo');

  const cache = new DatabaseSync(dbPath);
  cache.prepare(`
    INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(raw_address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng
  `).run(ADDRESS, ZONE.lat, ZONE.lng, 'Neiva, Huila');
  cache.close();

  dateSabado = proximoDia(6);

  await api('POST', '/api/flavors', { token, body: { id: 'cd-fresa', name: 'CD Fresa', price: 8000, available: 1 } });
  flavorId = 'cd-fresa';

  await api('PUT', '/api/delivery-config', {
    token,
    body: {
      delivery_immediate_enabled: 1,
      delivery_immediate_fee_cents: 3000,
      delivery_immediate_base_fare_cents: 0,
      delivery_immediate_price_per_km_cents: 0,
      delivery_immediate_min_order_cents: 0,
      delivery_immediate_radius_km: 5,
      delivery_zone_center_lat: ZONE.lat,
      delivery_zone_center_lng: ZONE.lng,
    },
  });

  await api('POST', '/api/release-windows', {
    token,
    body: {
      release_date: dateSabado, cutoff_at: `${dateSabado}T09:00:00`, status: 'open',
      items: [{ flavor_id: flavorId, units_available: 50 }],
    },
  });
  await api('POST', '/api/delivery-schedule', {
    token,
    body: {
      day_of_week: new Date(`${dateSabado}T12:00:00Z`).getUTCDay(), mode: 'both',
      start_time: '12:00', end_time: '17:00', cutoff_offset_hours: 0, active: 1,
    },
  });

  const a = await crearDomiciliario({
    name: 'Domiciliario A', phone: '573001111111', email: 'domA@courier.local', password: 'DomiciliarioA123!',
    lat: ZONE.lat, lng: ZONE.lng, base_fare_cents: 3500, price_per_km_cents: 1600,
  });
  const b = await crearDomiciliario({
    name: 'Domiciliario B', phone: '573002222222', email: 'domB@courier.local', password: 'DomiciliarioB123!',
    lat: ZONE.lat, lng: ZONE.lng,
  });
  courierA = a.json;
  courierB = b.json;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('el admin crea el domiciliario con su cuenta de portal (rol courier)', async () => {
  assert.equal(courierA?.id > 0, true, `no se creo el domiciliario: ${JSON.stringify(courierA)}`);
  assert.equal(courierA.has_account, true);
  assert.equal(courierA.phone_display, '+573001111111');

  const portal = await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  });
  assert.equal(portal.status, 200, JSON.stringify(portal.json));
  assert.ok(portal.json?.token, 'el portal debe devolver token');
  assert.equal(portal.json?.courier?.name, 'Domiciliario A');
});

test('el CRUD de domiciliario es admin-only', async () => {
  const sinToken = await api('GET', '/api/couriers');
  assert.equal(sinToken.status, 401);

  const customer = await api('POST', '/api/auth/register', {
    body: { email: `cliente-${Date.now()}@test.local`, password: 'Cliente123!', name: 'Cliente' },
  });
  const comoCliente = await api('GET', '/api/couriers', { token: customer.json?.token });
  assert.equal(comoCliente.status, 403, `esperaba 403: ${JSON.stringify(comoCliente.json)}`);
});

test('una cuenta que no es de domiciliario no entra al portal', async () => {
  const customer = await api('POST', '/api/auth/register', {
    body: { email: `cliente2-${Date.now()}@test.local`, password: 'Cliente123!', name: 'Cliente' },
  });
  const portal = await api('POST', '/api/courier/login', {
    body: { email: customer.json?.user?.email, password: 'Cliente123!' },
  });
  assert.equal(portal.status, 403, `esperaba 403: ${JSON.stringify(portal.json)}`);
  assert.equal(portal.json?.error, 'forbidden');
});

test('el pedido de domicilio recibe reparto automatico', async () => {
  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json?.dispatch?.assigned, true, `esperaba reparto asignado: ${JSON.stringify(r.json?.dispatch)}`);
  assert.equal(r.json?.dispatch?.courier_id, courierA.id, 'sin carga, el de menos carga activa gana');
  assert.equal(r.json?.dispatch?.dispatch?.status, 'assigned');
});

test('el domiciliario con menos carga activa es el siguiente en recibir el pedido', async () => {
  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201);
  assert.equal(r.json?.dispatch?.courier_id, courierB.id, 'A ya tiene carga, le toca B');
});

test('sin domiciliario elegible el pedido NO falla: queda sin reparto (fail-closed)', async () => {
  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: false } });

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, 'el cliente no debe ver un fallo por falta de repartidor');
  assert.equal(r.json?.dispatch?.assigned, false);
  assert.equal(r.json?.dispatch?.reason, 'no_active_couriers');

  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: true } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: true } });
});

test('el admin puede asignar a mano el pedido que quedo en la cola', async () => {
  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: false } });

  const creado = await pedidoDomicilio(uniq());
  assert.equal(creado.json?.dispatch?.assigned, false, 'sin repartidores el pedido queda en la cola');

  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: true } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: true } });

  const orderId = creado.json?.id;
  const manual = await api('POST', `/api/couriers/${courierA.id}/dispatch`, { token, body: { order_id: orderId } });
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  assert.equal(manual.json?.dispatch?.assigned_by, 'manual');
  assert.equal(manual.json?.courier_id, courierA.id);
});

test('el domiciliario solo ve SU cola', async () => {
  const login = await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  });
  const cola = await api('GET', '/api/courier/queue', { token: login.json?.token });
  assert.equal(cola.status, 200);
  const ids = (cola.json?.dispatches || []).map(d => d.id);
  assert.ok(ids.length >= 1, 'A debe ver al menos el pedido asignado a mano');
  for (const d of cola.json.dispatches) {
    assert.equal(d.courier_id ?? courierA.id, courierA.id);
    assert.ok(d.order_id, 'cada reparto trae su pedido');
    assert.ok('items' in d && 'combos' in d, 'la cola trae el contenido del pedido');
  }
});

test('un domiciliario no puede tocar el reparto de otro', async () => {
  const loginB = await api('POST', '/api/courier/login', {
    body: { email: 'domB@courier.local', password: 'DomiciliarioB123!' },
  });
  const colaA = await api('GET', '/api/courier/queue', { token: loginB.json?.token });
  const dispatchA = (await api('GET', '/api/courier/queue', {
    token: (await api('POST', '/api/courier/login', {
      body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
    })).json?.token,
  })).json?.dispatches?.[0];

  assert.ok(dispatchA, 'A debe tener repartos');
  const intruso = await api('POST', `/api/courier/dispatch/${dispatchA.id}/status`, {
    token: loginB.json?.token, body: { status: 'picked_up' },
  });
  assert.equal(intruso.status, 403, `esperaba 403: ${JSON.stringify(intruso.json)}`);
  assert.ok(colaA.status === 200);
});

test('la maquina de estados del reparto es estricta e idempotente', async () => {
  const tokenA = (await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  })).json?.token;
  const cola = await api('GET', '/api/courier/queue', { token: tokenA });
  const d = cola.json?.dispatches?.[0];
  assert.ok(d, 'A debe tener repartos');

  const invalido = await api('POST', `/api/courier/dispatch/${d.id}/status`, {
    token: tokenA, body: { status: 'delivered' },
  });
  assert.equal(invalido.status, 409, `esperaba 409: ${JSON.stringify(invalido.json)}`);
  assert.equal(invalido.json?.error, 'invalid_transition');

  const recogido = await api('POST', `/api/courier/dispatch/${d.id}/status`, {
    token: tokenA, body: { status: 'picked_up' },
  });
  assert.equal(recogido.status, 200);
  assert.equal(recogido.json?.changed, true);

  const repetido = await api('POST', `/api/courier/dispatch/${d.id}/status`, {
    token: tokenA, body: { status: 'picked_up' },
  });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.json?.changed, false, 'repetir la misma transicion no es error');

  const enCamino = await api('POST', `/api/courier/dispatch/${d.id}/status`, {
    token: tokenA, body: { status: 'on_way' },
  });
  assert.equal(enCamino.json?.dispatch?.status, 'on_way');
});

test('confirmar el cobro contra entrega es idempotente y deja el pedido pagado', async () => {
  const tokenA = (await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  })).json?.token;
  const cola = await api('GET', '/api/courier/queue', { token: tokenA });
  const d = cola.json?.dispatches?.find(x => x.status === 'on_way' || x.status === 'picked_up');
  assert.ok(d, 'debe haber un reparto para cobrar');

  const cobro = await api('POST', `/api/courier/dispatch/${d.id}/collect-cash`, { token: tokenA });
  assert.equal(cobro.status, 200, JSON.stringify(cobro.json));
  assert.equal(cobro.json?.already, false);
  assert.equal(cobro.json?.dispatch?.cod_collected, true);

  const repetido = await api('POST', `/api/courier/dispatch/${d.id}/collect-cash`, { token: tokenA });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.json?.already, true, 'cobrar dos veces no puede crear dos pagos');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const order = db.prepare('SELECT payment_status FROM orders WHERE id = ?').get(d.order_id);
  db.close();
  assert.equal(order.payment_status, 'paid', 'el pedido debe quedar pagado');
});

test('el domiciliario envia su ubicacion (heartbeat)', async () => {
  const tokenA = (await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  })).json?.token;
  const r = await api('POST', '/api/courier/location', {
    token: tokenA, body: { lat: ZONE.lat + 0.01, lng: ZONE.lng + 0.01, accuracy: 12 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const lista = await api('GET', '/api/couriers', { token });
  const a = lista.json?.couriers?.find(c => c.id === courierA.id);
  assert.ok(Math.abs(a.lat - (ZONE.lat + 0.01)) < 0.0001, 'la ubicacion debe quedar en el perfil');

  const malo = await api('POST', '/api/courier/location', { token: tokenA, body: { lat: 999, lng: 0 } });
  assert.equal(malo.status, 400);
});

test('un domiciliario con repartos no se puede borrar (historial)', async () => {
  const r = await api('DELETE', `/api/couriers/${courierA.id}`, { token });
  assert.equal(r.status, 409, `esperaba 409: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.error, 'courier_has_dispatches');
});

test('la cola trae el costo con las MISMAS reglas que la landing', async () => {
  const tokenA = (await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  })).json?.token;
  const cola = await api('GET', '/api/courier/queue', { token: tokenA });
  const d = cola.json?.dispatches?.[0];
  assert.ok(d, 'A debe tener repartos');
  assert.ok(d.cost, 'cada reparto debe traer el costo');
  assert.equal(typeof d.cost.subtotal_cents, 'number');
  assert.equal(d.cost.total_cents, d.total, 'el total a cobrar es el del pedido');
  assert.ok(d.cost.subtotal_cents > 0, 'el subtotal sale del catalogo, no del cliente');

  // La MISMA cotizacion que hace la landing para esa direccion.
  const quote = await api('POST', '/api/delivery/quote', {
    body: { address: ADDRESS, subtotal_cents: d.cost.subtotal_cents },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(d.cost.delivery_fee_cents, quote.json.fee_cents,
    `el domiciliario debe ver el mismo precio que el cliente: ${d.cost.delivery_fee_cents} vs ${quote.json.fee_cents}`);
  assert.equal(d.cost.source, 'landing');

  // Los items traen el precio de catalogo, no el que mandaba el cliente.
  for (const i of d.items) assert.equal(typeof i.unit_price_cents, 'number');
  for (const c of d.combos) assert.equal(typeof c.unit_price_cents, 'number');

  // Y toda la informacion del pedido: ventana, pago y notas.
  assert.ok(d.window && d.window.day, 'la cola debe traer la ventana de recogida');
  assert.ok(d.payment, 'la cola debe traer el estado del pago');
});

test('el costo de recogida del domiciliario usa su tarifa propia con piso de margen', async () => {
  const tokenA = (await api('POST', '/api/courier/login', {
    body: { email: 'domA@courier.local', password: 'DomiciliarioA123!' },
  })).json?.token;
  const cola = await api('GET', '/api/courier/queue', { token: tokenA });
  const d = cola.json?.dispatches?.[0];
  const pickup = d.cost.courier_pickup;
  assert.ok(pickup, 'el reparto debe traer el costo de recogida');
  assert.equal(pickup.source, 'tarifa_propia');
  assert.ok(pickup.cents >= pickup.floor_cents, 'el piso de margen no puede bajar el precio');
  // Su tarifa propia: base 3500 + 1600/km por la distancia entre el negocio y
  // la ultima ubicacion que reporto (redondeado a $50, como el resto del app).
  const esperado = Math.round((3500 + 1600 * pickup.distance_km) / 50) * 50;
  assert.equal(pickup.base_cents, esperado, 'la recogida se cobra con la tarifa propia del domiciliario');
  assert.ok(pickup.distance_km >= 0);
});

test('r4/r10 — el piso de margen aplica el % sobre el costo', async () => {
  // Solo C queda activo: el reparto automatico no se puede revolver con la
  // carga de A y B.
  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: false } });

  const cfg = await api('PUT', '/api/delivery-config', {
    token, body: { courier_margin_pct: 100, courier_min_margin_cents: 0 },
  });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal(cfg.json?.courier_margin_pct, 100, 'el margen se guarda en la config');

  const c = await crearDomiciliario({
    name: 'Domiciliario C', phone: '573004444444', email: 'domC@courier.local', password: 'DomiciliarioC123!',
    lat: ZONE.lat, lng: ZONE.lng, base_fare_cents: 3500, price_per_km_cents: 1600,
  });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  courierC = c.json;

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json?.dispatch?.assigned, true, 'C es el unico activo');
  assert.equal(r.json?.dispatch?.courier_id, courierC.id);

  const cola = await colaDe('domC@courier.local', 'DomiciliarioC123!');
  const d = cola.find(x => x.order_id === r.json?.id);
  assert.ok(d, 'el reparto nuevo debe estar en la cola de C');
  const pickup = d.cost.courier_pickup;
  assert.equal(pickup.frozen, true, 'el precio queda congelado al asignar');
  assert.equal(pickup.cost_cents, 3000, 'el costo es lo que el domicilio le cuesta al negocio');
  assert.equal(pickup.margin_required_cents, 3000, 'el % se aplica sobre el costo');
  assert.equal(pickup.floor_cents, 6000, 'el piso es el costo mas el margen');
  assert.ok(pickup.cents >= pickup.floor_cents, 'el piso de margen no puede bajar el precio');
});

test('r4/r10 — el minimo por pedido manda sobre el %', async () => {
  const cfg = await api('PUT', '/api/delivery-config', {
    token, body: { courier_margin_pct: 10, courier_min_margin_cents: 5000 },
  });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));

  const cola = await colaDe('domC@courier.local', 'DomiciliarioC123!');
  const d = cola.find(x => x.order_id === r.json?.id);
  assert.ok(d, 'el reparto nuevo debe estar en la cola de C');
  const pickup = d.cost.courier_pickup;
  assert.equal(pickup.margin_required_cents, 5000, 'el minimo por pedido manda sobre el %');
  assert.equal(pickup.floor_cents, 8000, 'el piso es el costo mas el minimo por pedido');
  assert.ok(pickup.cents >= pickup.floor_cents, 'el piso no puede bajar el precio');
});

test('r4/r10 — el precio de recogida no cambia aunque el domicillero se mueva', async () => {
  await api('PUT', '/api/delivery-config', {
    token, body: { courier_margin_pct: 0, courier_min_margin_cents: 0 },
  });

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));

  const antes = (await colaDe('domC@courier.local', 'DomiciliarioC123!')).find(x => x.order_id === r.json?.id);
  assert.ok(antes, 'el reparto debe estar en la cola');
  const pickupAntes = antes.cost.courier_pickup;
  assert.equal(pickupAntes.frozen, true);

  // El domicillero se mueve lejos del negocio: su tarifa propia daria otro
  // numero...
  const tokenC = (await api('POST', '/api/courier/login', {
    body: { email: 'domC@courier.local', password: 'DomiciliarioC123!' },
  })).json?.token;
  const movido = await api('POST', '/api/courier/location', {
    token: tokenC, body: { lat: ZONE.lat + 0.05, lng: ZONE.lng, accuracy: 12 },
  });
  assert.equal(movido.status, 200, JSON.stringify(movido.json));

  // ...pero el precio que ve el domicillero es el que quedo congelado.
  const despues = (await colaDe('domC@courier.local', 'DomiciliarioC123!')).find(x => x.order_id === r.json?.id);
  assert.equal(despues.cost.courier_pickup.cents, pickupAntes.cents, 'el precio de recogida es inmutable');
  assert.equal(
    despues.cost.courier_pickup.distance_km,
    pickupAntes.distance_km,
    'la distancia del precio tambien queda congelada',
  );
});

test('r4/r10 — sin ubicacion del domiciliario la distancia cae al pedido', async () => {
  await api('PATCH', `/api/couriers/${courierC.id}`, { token, body: { active: false } });

  const d = await crearDomiciliario({
    name: 'Domiciliario D', phone: '573005555555', email: 'domD@courier.local', password: 'DomiciliarioD123!',
    base_fare_cents: 2000, price_per_km_cents: 1000,
  });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  courierD = d.json;

  // Direccion a 3,3 km del negocio: la zona la acepta y la distancia es real.
  cacheAddress(LEJOS, ZONE.lat + 0.03, ZONE.lng);

  const r = await api('POST', '/api/orders', {
    body: {
      id: uniq(), customer_name: 'Cliente Lejano', customer_phone: '573001220000',
      pickup_day: dateSabado, items: { [flavorId]: 1 }, combos: [],
      total: 8000, source: 'test',
      delivery_mode: 'immediate', delivery_address: LEJOS,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json?.dispatch?.assigned, true, 'D es el unico activo');
  assert.equal(r.json?.dispatch?.courier_id, courierD.id);

  const cola = await colaDe('domD@courier.local', 'DomiciliarioD123!');
  const rep = cola.find(x => x.order_id === r.json?.id);
  assert.ok(rep, 'el reparto debe estar en la cola de D');
  const pickup = rep.cost.courier_pickup;
  assert.equal(pickup.source, 'fallback_cliente', 'sin ubicacion, la distancia sale del pedido');
  assert.ok(pickup.distance_km > 0, 'la distancia de fallback es la del pedido');
  const esperado = Math.round((2000 + 1000 * pickup.distance_km) / 50) * 50;
  assert.equal(pickup.base_cents, esperado, 'la tarifa propia se aplica sobre esa distancia');

  // Se deja el estado como estaba.
  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: true } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: true } });
});

test('r11 — el admin recibe en vivo el reparto que se asigna', async () => {
  const stream = await openEventStream(token);
  await new Promise(r => setTimeout(r, 200));

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));

  const evento = await waitFor(() => stream.events.find(e => e.type === 'dispatch.assigned'));
  assert.ok(evento, 'el admin debe recibir el evento del reparto asignado');
  assert.equal(evento.data.order_id, r.json?.id);
  assert.ok(Number(evento.data.courier_id) > 0, 'el evento dice a quien se asigno');

  await stream.stop();
});

test('r11 — el domicillero recibe solo los repartos que son suyos', async () => {
  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierD.id}`, { token, body: { active: false } });
  await api('PATCH', `/api/couriers/${courierC.id}`, { token, body: { active: true } });

  const tokenC = (await api('POST', '/api/courier/login', {
    body: { email: 'domC@courier.local', password: 'DomiciliarioC123!' },
  })).json?.token;
  const stream = await openEventStream(tokenC);
  await new Promise(r => setTimeout(r, 200));

  const r = await pedidoDomicilio(uniq());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json?.dispatch?.courier_id, courierC.id, 'C es el unico activo');

  const evento = await waitFor(() => stream.events.find(e => e.type === 'dispatch.assigned'));
  assert.ok(evento, 'el domicillero debe recibir su reparto en vivo');
  assert.equal(evento.data.courier_id, courierC.id);

  // Un reparto de otro domicillero no le llega.
  const ajenos = stream.events.filter(e => e.type === 'dispatch.assigned' && e.data.courier_id !== courierC.id);
  assert.equal(ajenos.length, 0, 'el domicillero no debe ver repartos de otros');

  await stream.stop();

  await api('PATCH', `/api/couriers/${courierA.id}`, { token, body: { active: true } });
  await api('PATCH', `/api/couriers/${courierB.id}`, { token, body: { active: true } });
  await api('PATCH', `/api/couriers/${courierD.id}`, { token, body: { active: true } });
});
