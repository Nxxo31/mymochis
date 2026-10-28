import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { businessClock } from '../src/lib/business-time.js';
import { computeDeliveryFeeCents } from '../src/lib/delivery-fee.js';
import {
  deliveryFreeDecision,
  evaluateDelivery,
  selectDeliveryFreeRule,
  validateDeliveryCoordinates,
} from '../src/lib/delivery-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4201;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@delivery-rules.test';
const ADMIN_PASSWORD = 'DeliveryRules123!';
const ADDRESS = 'Calle 45 #67-89, Neiva, Huila';
const FLAVOR_ID = 'd1-fresa';
const FLAVOR_PRICE = 8000;

let child;
let tmpDir;
let dbPath;
let token;
let ruleId;

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

async function api(method, path, { body, accessToken } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

test('fecha de negocio: America/Bogota cambia de día a las 05:00 UTC', () => {
  const antes = businessClock('2026-10-24T04:59:59.999Z');
  const despues = businessClock('2026-10-24T05:00:00.000Z');
  assert.equal(antes.business_date, '2026-10-23');
  assert.equal(antes.business_tz, 'America/Bogota');
  assert.equal(antes.day_of_week, 5);
  assert.equal(despues.business_date, '2026-10-24');
  assert.equal(despues.day_of_week, 6);
});

test('regla activa y específica gana sobre una regla general', () => {
  const clock = businessClock('2026-10-23T20:00:00.000Z');
  const rules = [
    { id: 1, day_of_week: 5, free_delivery: 1, label: 'General', min_order_cents: 0, starts_at: null, ends_at: null, active: 1 },
    { id: 2, day_of_week: 5, free_delivery: 1, label: 'Ventana', min_order_cents: 0, starts_at: '14:00', ends_at: '17:00', active: 1 },
  ];
  assert.equal(selectDeliveryFreeRule(rules, clock).id, 2);
  assert.equal(selectDeliveryFreeRule([{ ...rules[0], active: 0 }], clock), null);
});

test('la gratuidad con mínimo usa el subtotal y falla cerrada', () => {
  const rule = { id: 7, day_of_week: 5, free_delivery: 1, label: 'Viernes', min_order_cents: 20000, starts_at: null, ends_at: null, active: 1 };
  const rules = [rule];
  assert.equal(deliveryFreeDecision({ rules, subtotalCents: 19999, nowMs: Date.parse('2026-10-23T20:00:00.000Z') }).free_delivery, false);
  assert.equal(deliveryFreeDecision({ rules, subtotalCents: 20000, nowMs: Date.parse('2026-10-23T20:00:00.000Z') }).free_delivery, true);
  assert.equal(deliveryFreeDecision({ rules, subtotalCents: 999999, nowMs: Date.parse('2026-10-23T20:00:00.000Z') }).free_delivery, true);
});

test('radio cero equivale a sin límite y no exige centro con tarifa plana', () => {
  const evaluation = evaluateDelivery({
    config: {
      delivery_immediate_enabled: 1,
      delivery_immediate_fee_cents: 5000,
      delivery_immediate_base_fare_cents: 0,
      delivery_immediate_price_per_km_cents: 0,
      delivery_immediate_radius_km: 0,
      delivery_zone_center_lat: null,
      delivery_zone_center_lng: null,
    },
    geo: { lat: 2.9754, lng: -75.1812 },
    address: ADDRESS,
    rules: [],
    subtotalCents: 8000,
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.within_zone, true);
  assert.equal(evaluation.distance_km, null);
  assert.equal(evaluation.fee_cents, 5000);
});

test('centro requerido ausente devuelve zone_not_configured', () => {
  const evaluation = evaluateDelivery({
    config: {
      delivery_immediate_enabled: 1,
      delivery_immediate_fee_cents: 5000,
      delivery_immediate_base_fare_cents: 3500,
      delivery_immediate_price_per_km_cents: 1600,
      delivery_immediate_radius_km: 5,
      delivery_zone_center_lat: null,
      delivery_zone_center_lng: null,
    },
    geo: { lat: 2.9754, lng: -75.1812 },
    address: ADDRESS,
    rules: [],
    subtotalCents: 8000,
  });
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.error, 'zone_not_configured');
});

test('coordenadas de zona: rango, pareja y vacío->null', () => {
  assert.deepEqual(validateDeliveryCoordinates('', ''), { lat: null, lng: null });
  assert.equal(validateDeliveryCoordinates(91, 0).error, 'lat_out_of_range');
  assert.equal(validateDeliveryCoordinates(0, 181).error, 'lng_out_of_range');
  assert.equal(validateDeliveryCoordinates(1, null).error, 'coordinates_required_together');
  assert.deepEqual(validateDeliveryCoordinates('2.9', '-75.1'), { lat: 2.9, lng: -75.1 });
});

test('fee de día gratis es cero y conserva la fórmula retro-compatible', () => {
  const config = { delivery_immediate_fee_cents: 5000, delivery_immediate_base_fare_cents: 3500, delivery_immediate_price_per_km_cents: 1600 };
  assert.equal(computeDeliveryFeeCents(config, 3.2), 8600);
  assert.equal(computeDeliveryFeeCents(config, 3.2, { freeDelivery: true }), 0);
});

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-delivery-rules-'));
  dbPath = join(tmpDir, 'test.db');
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: dbPath,
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const login = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.ok(login.json?.token);
  token = login.json.token;
  const flavor = await api('POST', '/api/flavors', {
    accessToken: token,
    body: { id: FLAVOR_ID, name: 'D1 Fresa', price: FLAVOR_PRICE, available: 1 },
  });
  assert.equal(flavor.status, 201, JSON.stringify(flavor.json));
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(raw_address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng
  `).run(ADDRESS, 2.9754, -75.1812, 'Dirección de prueba');
  db.close();
  const config = await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: {
      delivery_immediate_enabled: 1,
      delivery_immediate_fee_cents: 5000,
      delivery_immediate_base_fare_cents: 3500,
      delivery_immediate_price_per_km_cents: 1600,
      delivery_immediate_radius_km: 5,
      delivery_immediate_min_order_cents: 1000,
      delivery_zone_address: 'Cocina central',
      delivery_zone_place_id: 'place-test',
      delivery_zone_center_lat: 2.9754,
      delivery_zone_center_lng: -75.1812,
    },
  });
  assert.equal(config.status, 200, JSON.stringify(config.json));
  const rule = await api('POST', '/api/delivery-rules', {
    accessToken: token,
    body: {
      day_of_week: businessClock().day_of_week,
      free_delivery: 1,
      label: 'Día gratis de prueba',
      min_order_cents: 5000,
      starts_at: null,
      ends_at: null,
      active: 1,
      notes: 'Regla D1',
    },
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.json));
  ruleId = rule.json.id;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('CRUD de reglas exige admin y publica solo reglas activas', async () => {
  const denied = await api('POST', '/api/delivery-rules', {
    body: { day_of_week: 1, free_delivery: 1, label: 'No autorizado' },
  });
  assert.equal(denied.status, 401);
  const created = await api('POST', '/api/delivery-rules', {
    accessToken: token,
    body: { day_of_week: 1, free_delivery: 1, label: 'Lunes gratis', min_order_cents: 1000, active: 1 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const updated = await api('PUT', `/api/delivery-rules/${created.json.id}`, {
    accessToken: token,
    body: { min_order_cents: 2500 },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.min_order_cents, 2500);
  const publicRules = await api('GET', '/api/delivery-rules');
  assert.equal(publicRules.status, 200);
  assert.ok(publicRules.json.some(r => r.id === created.json.id));
  const removed = await api('DELETE', `/api/delivery-rules/${created.json.id}`, { accessToken: token });
  assert.equal(removed.status, 200);
});

test('/api/public publica fecha, zona horaria, reglas y estado de gratuidad', async () => {
  const response = await api('GET', '/api/public');
  assert.equal(response.status, 200);
  assert.equal(response.json.business_tz, 'America/Bogota');
  assert.match(response.json.business_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof response.json.today_free_delivery, 'boolean');
  assert.ok(Array.isArray(response.json.delivery_free_rules));
  assert.ok(response.json.delivery_free_rules.some(r => r.id === ruleId));
  assert.equal(response.json.delivery_config.delivery_zone_address, 'Cocina central');
  assert.equal(response.json.delivery_config.delivery_zone_place_id, 'place-test');
});

test('quote y pedido comparten evaluación y el pedido ignora coordenadas manipuladas', async () => {
  const quote = await api('POST', '/api/delivery/quote', {
    body: { address: ADDRESS, subtotal_cents: FLAVOR_PRICE, delivery_lat: 20, delivery_lng: 20 },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(quote.json.fee_cents, 0);
  assert.equal(quote.json.free_delivery, true);
  assert.equal(quote.json.delivery_free_rule_id, ruleId);
  const order = await api('POST', '/api/orders', {
    body: {
      id: `D1-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: 999999,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
      delivery_lat: 20,
      delivery_lng: 20,
    },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  assert.equal(order.json.delivery_fee_cents, 0);
  assert.equal(order.json.delivery_free_applied, 1);
  assert.equal(order.json.delivery_free_rule_id, ruleId);
  assert.equal(order.json.total, FLAVOR_PRICE);
});

test('sin regla activa quote y pedido cobran la misma tarifa autoritativa', async () => {
  const disabled = await api('PUT', `/api/delivery-rules/${ruleId}`, {
    accessToken: token,
    body: { active: 0 },
  });
  assert.equal(disabled.status, 200);
  const quote = await api('POST', '/api/delivery/quote', {
    body: { address: ADDRESS, subtotal_cents: FLAVOR_PRICE, delivery_lat: 20, delivery_lng: 20 },
  });
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(quote.json.fee_cents, 3500);
  assert.equal(quote.json.free_delivery, false);
  const order = await api('POST', '/api/orders', {
    body: {
      id: `D1-NORMAL-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: 1,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
      delivery_lat: 20,
      delivery_lng: 20,
    },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  assert.equal(order.json.delivery_fee_cents, 3500);
  assert.equal(order.json.delivery_free_applied, 0);
  assert.equal(order.json.delivery_free_rule_id, null);
  assert.equal(order.json.total, FLAVOR_PRICE + 3500);
});

test('el mínimo autoritativo se valida después de priceOrder', async () => {
  await api('PUT', `/api/delivery-rules/${ruleId}`, {
    accessToken: token,
    body: { active: 1, min_order_cents: 9000 },
  });
  await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: { delivery_immediate_min_order_cents: 12000 },
  });
  const order = await api('POST', '/api/orders', {
    body: {
      id: `D1-MIN-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: 999999,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });
  assert.equal(order.status, 400, JSON.stringify(order.json));
  assert.equal(order.json.error, 'below_minimum');
  assert.match(order.json.message, /12\.000/);
  await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: { delivery_immediate_min_order_cents: 1000 },
  });
  const belowRuleMinimum = await api('POST', '/api/orders', {
    body: {
      id: `D1-RULE-MIN-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: 999999,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });
  assert.equal(belowRuleMinimum.status, 201, JSON.stringify(belowRuleMinimum.json));
  assert.equal(belowRuleMinimum.json.delivery_fee_cents, 3500);
  assert.equal(belowRuleMinimum.json.delivery_free_applied, 0);
  assert.equal(belowRuleMinimum.json.delivery_free_rule_id, null);
});

test('zona no configurada falla explícitamente en quote y pedido', async () => {
  const config = await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: { delivery_zone_center_lat: null, delivery_zone_center_lng: null },
  });
  assert.equal(config.status, 200, JSON.stringify(config.json));
  const quote = await api('POST', '/api/delivery/quote', { body: { address: ADDRESS } });
  assert.equal(quote.status, 503, JSON.stringify(quote.json));
  assert.equal(quote.json.error, 'zone_not_configured');
  const order = await api('POST', '/api/orders', {
    body: {
      id: `D1-ZONE-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: FLAVOR_PRICE,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });
  assert.equal(order.status, 400, JSON.stringify(order.json));
  assert.equal(order.json.error, 'zone_not_configured');
});

test('radio cero sin centro usa tarifa plana y no limita la zona', async () => {
  const config = await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: {
      delivery_immediate_radius_km: 0,
      delivery_immediate_price_per_km_cents: 0,
      delivery_immediate_base_fare_cents: 0,
      delivery_immediate_fee_cents: 5000,
      delivery_zone_center_lat: null,
      delivery_zone_center_lng: null,
    },
  });
  assert.equal(config.status, 200, JSON.stringify(config.json));
  const quote = await api('POST', '/api/delivery/quote', { body: { address: ADDRESS } });
  assert.equal(quote.status, 200, JSON.stringify(quote.json));
  assert.equal(quote.json.within_zone, true);
  assert.equal(quote.json.distance_km, null);
  assert.equal(quote.json.fee_cents, 5000);
  const order = await api('POST', '/api/orders', {
    body: {
      id: `D1-RADIUS-0-${Date.now()}`,
      customer_name: 'Cliente D1',
      customer_phone: '573001234567',
      pickup_day: businessClock().business_date,
      items: { [FLAVOR_ID]: 1 },
      combos: [],
      total: FLAVOR_PRICE,
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  assert.equal(order.json.delivery_fee_cents, 5000);
  assert.equal(order.json.delivery_distance_km, null);
  assert.equal(order.json.total, FLAVOR_PRICE + 5000);
});

test('delivery-config rechaza coordenadas parciales o fuera de rango', async () => {
  const invalid = await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: { delivery_zone_center_lat: 91 },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'bad_request');
  const cleared = await api('PUT', '/api/delivery-config', {
    accessToken: token,
    body: { delivery_zone_address: '', delivery_zone_place_id: '' },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.delivery_zone_address, null);
  assert.equal(cleared.json.delivery_zone_place_id, null);
});

test('Worker replica la fórmula y la evaluación compartida', async () => {
  const workerFee = await import('../worker/lib/delivery-fee.js');
  const workerRules = await import('../worker/lib/delivery-rules.js');
  const config = { delivery_immediate_fee_cents: 5000, delivery_immediate_base_fare_cents: 3500, delivery_immediate_price_per_km_cents: 1600 };
  assert.equal(workerFee.computeDeliveryFeeCents(config, 3.2), computeDeliveryFeeCents(config, 3.2));
  assert.equal(workerFee.computeDeliveryFeeCents(config, 3.2, { freeDelivery: true }), 0);
  assert.equal(workerRules.evaluateDelivery, evaluateDelivery);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join(ROOT, 'worker/routes/orders.js'), 'utf8');
  assert.match(source, /evaluateDelivery/);
  assert.match(source, /authoritativeTotal/);
  assert.match(source, /delivery_free_applied/);
  assert.doesNotMatch(source, /body\.delivery_lat|body\.delivery_lng/);
});
