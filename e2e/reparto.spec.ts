// E2E del ciclo de reparto (spec 57, r12):
// pedido -> asignacion automatica -> WSP al domicillero -> entrega -> cobro.
//
// El ciclo va por las dos superficies reales: el panel admin (crea el
// domiciliario) y el portal del domiciliario (reporta su ubicacion, avanza los
// estados y cobra contra entrega). La API solo se usa para el setup y para
// leer el estado final.
//
// Hermetico: la direccion del cliente se precachea en la DB temporal (el
// e2e/server.mjs publica la ruta de la DB en el archivo de estado) para no
// depender de Nominatim ni de la red.
//
// Los tres proyectos de Playwright (movil/tablet/desktop) comparten el mismo
// server, asi que cada proyecto usa SU domiciliario y SUS pedidos: si no, el
// segundo proyecto encontraria el domicatario ya creado y contaria repartos
// ajenos.

import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADMIN = { email: 'admin@e2e.test', password: 'E2eTest123!' };
const ADDRESS = 'Calle 10 #5-20, Neiva, Huila';
const ZONE = { lat: 2.9273, lng: -75.2898 };
const STATE_FILE = join(tmpdir(), 'mymochis-e2e-state.json');

let adminToken = '';
let pickupDay = '';
let orderId = '';
let dispatchId = 0;

type ApiRes = { status: number; json: any };

async function api(
  request: APIRequestContext,
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<ApiRes> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await request.fetch(path, {
    method,
    headers,
    data: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status(), json };
}

// Los errores de red (404 de favicon, 401 esperadas) no son fallos del
// producto: solo nos interesan los errores de JS.
function esRuido(texto: string) {
  return /Failed to load resource|favicon|net::ERR|status of 401|status of 404/i.test(texto);
}

function proximoSabado() {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const cand = new Date(d.getTime() + i * 86400000);
    if (cand.getUTCDay() === 6) return cand.toISOString().slice(0, 10);
  }
  throw new Error('no se encontro un sabado');
}

// Identidad del domicillero por proyecto: nunca choca entre proyectos.
function courierDe(testInfo: TestInfo) {
  const slug = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  const code = [...testInfo.project.name].reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    nombre: `Domiciliario ${slug}`,
    phone: `573${String(1000000 + (code % 9000000)).slice(0, 7)}`,
    email: `dom-${slug}@e2e.test`,
    password: 'Domiciliario123!',
  };
}

async function entrarAlPanel(page: Page) {
  await page.addInitScript(() => localStorage.setItem('mymochis_tour_done', '1'));
  await page.goto('/manage.html');
  await page.waitForTimeout(600);
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', ADMIN.password);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('.app.visible');
}

async function entrarAlPortal(page: Page, courier: { email: string; password: string }) {
  await page.goto('/domicILIARIO.html');
  await page.fill('#email', courier.email);
  await page.fill('#password', courier.password);
  await page.click('#login-form button[type="submit"]');
  await expect(page.locator('#appView')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  let state: { dbPath: string };
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    throw new Error(
      `no existe ${STATE_FILE}: el server E2E no publico su DB (arranca con "npx playwright test" para que lo levante)`,
    );
  }

  const db = new DatabaseSync(state.dbPath);
  db.prepare(
    `INSERT INTO geocoded_addresses (raw_address, lat, lng, display_name, lookup_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(raw_address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng`,
  ).run(ADDRESS, ZONE.lat, ZONE.lng, 'Neiva, Huila');
  db.close();

  const login = await api(request, 'POST', '/api/auth/login', { body: ADMIN });
  expect(login.status).toBe(200);
  adminToken = login.json.token;

  pickupDay = proximoSabado();

  // El catalogo y las ventanas de la semana ya vienen sembrados por
  // scripts/seed-demo.mjs (con stock de 30 unidades por sabor). NO se crea
  // otra ventana para el mismo dia: resolveWindowStock se queda con la
  // primera 'open' de la fecha y una ventana duplicada sin este sabor rompe
  // el pedido con flavor_out_of_stock.
  const ventanas = await api(request, 'GET', '/api/release-windows?include_all=1', { token: adminToken });
  const ventana = (ventanas.json || []).find((w: any) => w.release_date === pickupDay);
  expect(ventana, `debe existir una ventana de release para ${pickupDay}`).toBeTruthy();
  expect(ventana.status).toBe('open');

  await api(request, 'PUT', '/api/delivery-config', {
    token: adminToken,
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

  // El horario de reparto del dia del pedido (la entrega inmediata exige
  // horario abierto; si ya existe uno, se actualiza en vez de duplicarlo).
  const horarios = await api(request, 'GET', '/api/delivery-schedule', { token: adminToken });
  const existente = (horarios.json || []).find((h: any) => h.day_of_week === 6);
  const cuerpoHorario = {
    day_of_week: 6,
    mode: 'both',
    start_time: '12:00',
    end_time: '17:00',
    cutoff_offset_hours: 0,
    active: 1,
  };
  if (existente) {
    await api(request, 'PUT', `/api/delivery-schedule/${existente.id}`, { token: adminToken, body: cuerpoHorario });
  } else {
    const creado = await api(request, 'POST', '/api/delivery-schedule', { token: adminToken, body: cuerpoHorario });
    expect(creado.status, `el horario de reparto debe quedar creado: ${JSON.stringify(creado.json)}`).toBe(201);
  }
});

test('el admin crea el domiciliario en Entregas > Domiciliarios', async ({ page }, testInfo) => {
  const courier = courierDe(testInfo);
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !esRuido(m.text())) errores.push(m.text());
  });

  await entrarAlPanel(page);
  await page.evaluate(() => (window as any).showSection('entregas'));
  await page.click('#entregas-tabs .pill[data-sub="domiciliarios"]');
  await expect(page.locator('#entregas-domiciliarios')).toHaveClass(/active/);

  await page.fill('#cf-name', courier.nombre);
  await page.fill('#cf-phone', courier.phone);
  await page.fill('#cf-email', courier.email);
  await page.fill('#cf-password', courier.password);
  await page.fill('#cf-base', '3500');
  await page.fill('#cf-perkm', '1600');
  await page.fill('#cf-radius', '15');
  await page.click('#courier-form button[type="submit"]');

  const fila = page.locator('#entregas-domiciliarios tbody tr', { hasText: courier.nombre });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText('con acceso');
  await expect(fila).toContainText('activo');

  expect(errores).toEqual([]);
});

test('el domicillero entra a su portal y reporta su ubicacion', async ({ browser, request }, testInfo) => {
  const courier = courierDe(testInfo);
  const ctx = await browser.newContext({
    geolocation: { latitude: ZONE.lat, longitude: ZONE.lng },
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto('/domicILIARIO.html');
  // Chromium exige el permiso con el origen exacto (http://localhost:4210).
  await ctx.grantPermissions(['geolocation'], { origin: new URL(page.url()).origin });
  await page.fill('#email', courier.email);
  await page.fill('#password', courier.password);
  await page.click('#login-form button[type="submit"]');
  await expect(page.locator('#appView')).toBeVisible();
  await expect(page.locator('#courierName')).toContainText(courier.nombre);

  const geo = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        if (!navigator.geolocation) return resolve('sin-geolocation');
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve('ok ' + pos.coords.latitude),
          (err) => resolve('err ' + err.code + ' ' + err.message),
          { enableHighAccuracy: true, timeout: 8000 },
        );
      }),
  );
  expect(geo, 'la geolocalizacion del navegador debe responder').toContain('ok');

  await page.click('#btnLocate');
  await expect(page.locator('#toast')).toContainText('Ubicaci');

  await expect
    .poll(
      async () => {
        const r = await api(request, 'GET', '/api/couriers', { token: adminToken });
        const c = (r.json?.couriers || []).find((x: any) => x.email === courier.email);
        return c && c.lat != null ? Number(c.lat) : null;
      },
      { timeout: 10000 },
    )
    .toBeCloseTo(ZONE.lat, 3);

  await ctx.close();
});

test('el pedido se asigna solo al domicillero y el WSP sale con deep link', async ({ request }, testInfo) => {
  const courier = courierDe(testInfo);
  const res = await api(request, 'POST', '/api/orders', {
    body: {
      id: `E2E-${testInfo.project.name}-${Date.now().toString(36)}`,
      customer_name: 'Cliente E2E',
      customer_phone: '573009998877',
      pickup_day: pickupDay,
      items: { 'clasico-fresa': 1 },
      combos: [],
      total: 8000,
      source: 'e2e',
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });

  expect(res.status, `el pedido debe crearse: ${JSON.stringify(res.json)}`).toBe(201);
  orderId = res.json.id;
  const d = res.json.dispatch;
  expect(d, 'el pedido debe traer el resultado de la asignacion').toBeTruthy();
  expect(d.assigned, 'el pedido tiene que quedar asignado a un domicillero').toBe(true);
  expect(d.courier_id).toBeTruthy();
  dispatchId = d.dispatch.id;

  // El WSP al repartidor (r6): plantilla propia + deep link de respaldo.
  expect(d.whatsapp.template).toBe('new_delivery_courier');
  expect(d.whatsapp.deep_link).toContain('api.whatsapp.com');
  expect(d.whatsapp.message).toContain(ADDRESS);
  expect(d.whatsapp.courier_phone).toBe(courier.phone);
});

test('el domicillero ve el reparto, avanza los estados y cobra contra entrega', async ({ browser, request }, testInfo) => {
  const courier = courierDe(testInfo);
  const ctx = await browser.newContext({
    geolocation: { latitude: ZONE.lat, longitude: ZONE.lng },
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !esRuido(m.text())) errores.push(m.text());
  });

  await entrarAlPortal(page, courier);

  const card = page.locator(`.card-dispatch[data-id="${dispatchId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(orderId);
  await expect(card).toContainText('Cliente E2E');

  // El precio de recogida congelado aparece en la cola del domicillero.
  await expect(card).toContainText('precio fijado al asignarte');

  await card.locator('button[data-act="status"][data-to="picked_up"]').click();
  await expect(card.locator('button[data-act="status"][data-to="on_way"]')).toBeVisible();

  await card.locator('button[data-act="status"][data-to="on_way"]').click();
  await expect(card.locator('button[data-act="status"][data-to="delivered"]')).toBeVisible();

  await card.locator('button[data-act="status"][data-to="delivered"]').click();
  await expect(card.locator('button[data-act="cash"]')).toBeVisible();

  await card.locator('button[data-act="cash"]').click();
  await expect(card).toContainText('Cobro confirmado');

  // El pedido quedo pagado y el stock vendido.
  const pedido = await api(request, 'GET', `/api/orders/${orderId}`, { token: adminToken });
  expect(pedido.status).toBe(200);
  expect(pedido.json.payment_status).toBe('paid');

  expect(errores).toEqual([]);
  await ctx.close();
});

test('el panel admin se actualiza solo cuando el reparto cambia (SSE)', async ({ page, request }, testInfo) => {
  const courier = courierDe(testInfo);
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !esRuido(m.text())) errores.push(m.text());
  });

  await entrarAlPanel(page);
  await page.evaluate(() => (window as any).showSection('entregas'));
  await page.click('#entregas-tabs .pill[data-sub="domiciliarios"]');

  const fila = page.locator('#entregas-domiciliarios tbody tr', { hasText: courier.nombre });
  await expect(fila).toBeVisible();
  // El reparto del test anterior ya quedo entregado.
  await expect(fila).toContainText('1 entregado(s)');
  await expect(fila).toContainText('0 activo(s)');

  // Un pedido nuevo debe llegar al panel sin recargar: el SSE (r11) publica
  // "dispatch.assigned" y el panel refresca el equipo de reparto.
  const res = await api(request, 'POST', '/api/orders', {
    body: {
      id: `E2E-SSE-${testInfo.project.name}-${Date.now().toString(36)}`,
      customer_name: 'Cliente SSE',
      customer_phone: '573009998866',
      pickup_day: pickupDay,
      items: { 'clasico-fresa': 1 },
      combos: [],
      total: 8000,
      source: 'e2e',
      delivery_mode: 'immediate',
      delivery_address: ADDRESS,
    },
  });
  expect(res.status, `el pedido debe crearse: ${JSON.stringify(res.json)}`).toBe(201);

  await expect(fila).toContainText('1 activo(s)', { timeout: 10000 });

  expect(errores).toEqual([]);
});
