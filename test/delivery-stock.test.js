// MyMochis · El domicilio tambien consume stock (P0, 2026-11-05).
//
// Antes el stock solo se reservaba para delivery_mode='scheduled': una entrega
// inmediata vendia mochis que no habian y no dejaba constancia de que ventana
// los consumio. Aqui queda fijado el contrato:
//
//   - entrega inmediata sin ventana abierta     -> 400 no_release_window
//   - entrega inmediata sin saldo               -> 409 insufficient_stock
//   - entrega inmediata con saldo               -> 201 y RESERVA el stock
//   - entrega inmediata sin horario de reparto  -> 400 no_delivery_schedule
//
// El geocodificado se siembra en la tabla `geocoded_addresses` (la misma cache
// que usa src/lib/geocode.js) para que el test no dependa de Nominatim.
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
const PORT = 4192;   // libre: 4177-4187, 4189, 4191, 4193 ya usados
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@deliverystock.local';
const ADMIN_PASSWORD = 'DeliveryStock123!';

const ADDRESS = 'Calle 10 #5-20, Neiva';
const ZONE = { lat: 2.927, lng: -75.289 };

let child, tmpDir, token, dbPath;
let dateLunes, dateSabado, dateDomingo, flavorId, comboId;

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

/** Fecha YYYY-MM-DD del proximo dia con el dow pedido (0=domingo). */
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
const uniq = () => `DS-${Date.now().toString(36)}-${n++}`;

function pedidoDomicilio(id, pickup_day, qty) {
  return api('POST', '/api/orders', {
    body: {
      id, customer_name: 'Domicilio Test', customer_phone: '573001220000',
      pickup_day, items: { [flavorId]: qty }, combos: [],
      total: 20000, source: 'test',
      delivery_mode: 'immediate', delivery_address: ADDRESS,
    },
  });
}

async function saldoDeLaVentana() {
  const r = await api('GET', '/api/release-windows', { token });
  const lista = Array.isArray(r.json) ? r.json : (r.json?.windows || []);
  const win = lista.find(w => w.release_date === dateSabado);
  assert.ok(win, 'no se encontro la ventana del sabado');
  const item = (win.items || []).find(i => i.flavor_id === flavorId);
  assert.ok(item, 'la ventana no tiene el item');
  return { reserved: item.units_reserved || 0, sold: item.units_sold || 0, available: item.units_available };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-ds-'));
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

  // Cache de geocodificado: el test no toca la red.
  const cache = new DatabaseSync(dbPath);
  cache.prepare(`
    INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(raw_address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng
  `).run(ADDRESS, ZONE.lat, ZONE.lng, 'Neiva, Huila');
  cache.close();

  dateLunes = proximoDia(1);
  dateSabado = proximoDia(6);
  dateDomingo = proximoDia(0);

  flavorId = 'ds-fresa';
  await api('POST', '/api/flavors', { token, body: { id: flavorId, name: 'DS Fresa', price: 8000, available: 1 } });
  const comboRes = await api('POST', '/api/combos', {
    token, body: { name: 'DS Combo', units: 6, price: 25000, available: true, units_available: 20 },
  });
  comboId = comboRes.json?.id;

  // Entrega inmediata activada con zona centered en la direccion cacheada.
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

  // Ventana abierta del sabado con 3 unidades: la entrega tiene stock real.
  await api('POST', '/api/release-windows', {
    token,
    body: {
      release_date: dateSabado, cutoff_at: `${dateSabado}T09:00:00`, status: 'open',
      items: [{ flavor_id: flavorId, units_available: 3 }],
    },
  });
  // El sabado la plantilla dice "solo pickup": se agrega una fila de reparto
  // para que el horario de domicilio exista.
  await api('POST', '/api/delivery-schedule', {
    token,
    body: {
      day_of_week: new Date(`${dateSabado}T12:00:00Z`).getUTCDay(), mode: 'both',
      start_time: '12:00', end_time: '17:00', cutoff_offset_hours: 0, active: 1,
    },
  });
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('entrega inmediata SIN ventana abierta -> 400 no_release_window', async () => {
  const r = await pedidoDomicilio(uniq(), dateLunes, 2);
  assert.equal(r.status, 400, `esperaba 400: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.error, 'no_release_window');
});

test('entrega inmediata SIN saldo -> 409 insufficient_stock', async () => {
  const r = await pedidoDomicilio(uniq(), dateSabado, 5);
  assert.equal(r.status, 409, `esperaba 409: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.error, 'insufficient_stock');
});

test('entrega inmediata CON saldo -> 201 y reserva el stock', async () => {
  const antes = await saldoDeLaVentana();
  const r = await pedidoDomicilio(uniq(), dateSabado, 2);
  assert.equal(r.status, 201, `esperaba 201: ${JSON.stringify(r.json)}`);

  const despues = await saldoDeLaVentana();
  assert.equal(despues.reserved, antes.reserved + 2, 'el domicilio debe RESERVAR el stock');
  assert.equal(despues.sold, antes.sold, 'un pedido sin pagar no puede contar como vendido');
});

test('entrega inmediata SIN horario de reparto -> 400 no_delivery_schedule', async () => {
  const r = await pedidoDomicilio(uniq(), dateDomingo, 1);
  assert.equal(r.status, 400, `esperaba 400: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.error, 'no_delivery_schedule');
});
