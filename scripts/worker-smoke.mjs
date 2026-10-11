import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const devVars = {};
try {
  for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) devVars[m[1]] = m[2].trim();
  }
} catch {}
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || devVars.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || devVars.ADMIN_PASSWORD;

let pass = 0;
let fail = 0;

function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function call(method, path, { token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { data = await res.json(); } catch {} }
  else if (!raw) { try { data = await res.text(); } catch {} }
  return { status: res.status, data, res };
}

function nextPickupDay(minDaysOut = 7) {
  for (let i = minDaysOut; i < minDaysOut + 14; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      return d.toISOString().slice(0, 10);
    }
  }
  throw new Error('no pickup day found');
}

const results = [];
const run = async (name, fn) => { results.push({ name, promise: fn().then((r) => check(name, ...r)).catch((e) => check(name, false, String(e)))) }; };

const health = await call('GET', '/api/health');
run('GET /api/health 200 ok', async () => [health.status === 200 && health.data?.ok === true, `status=${health.status}`]);
await results[0].promise;

const pub = await call('GET', '/api/public');
run('GET /api/public 200 con config/categories/flavors', async () => [pub.status === 200 && !!pub.data?.config && Array.isArray(pub.data?.categories) && Array.isArray(pub.data?.flavors), `status=${pub.status} keys=${Object.keys(pub.data || {}).join(',')}`]);
await results[1].promise;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.log('FALTAN CREDENCIALES ADMIN (.dev.vars o SMOKE_ADMIN_*) — smoke limitado a endpoints publicos');
} else {
  const login = await call('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const token = login.data?.token;
  run('login admin 200 con token', async () => [login.status === 200 && !!token, `status=${login.status} body=${JSON.stringify(login.data).slice(0, 200)}`]);
  await results[2].promise;

  const suffix = Date.now().toString(36);
  const flavorId = `smoke-${suffix}`;
  const createFlavor = await call('POST', '/api/flavors', { token, body: { id: flavorId, name: `Smoke ${suffix}`, description: 'smoke', price: 8000, available: 1 } });
  run('POST /api/flavors admin 201', async () => [createFlavor.status === 201, `status=${createFlavor.status} body=${JSON.stringify(createFlavor.data).slice(0, 200)}`]);
  await results[3].promise;

  const pickupDay = nextPickupDay(7);
  const cutoff = `${pickupDay}T00:00:00.000Z`;
  const openWin = await call('POST', '/api/release-windows', { token, body: { release_date: pickupDay, cutoff_at: cutoff, status: 'open', items: [{ flavor_id: flavorId, units_available: 10 }] } });
  run('POST /api/release-windows open 201 con items', async () => [openWin.status === 201 && Array.isArray(openWin.data?.items) && openWin.data.items.length === 1, `status=${openWin.status} body=${JSON.stringify(openWin.data).slice(0, 300)}`]);
  await results[4].promise;

  const draftWin = await call('POST', '/api/release-windows', { token, body: { release_date: pickupDay, cutoff_at: cutoff, status: 'draft', items: [{ flavor_id: flavorId, units_available: 5 }] } });
  run('POST /api/release-windows draft 201', async () => [draftWin.status === 201, `status=${draftWin.status}`]);
  await results[5].promise;

  const listPublic = await call('GET', '/api/release-windows');
  const hasDraftPublic = (listPublic.data || []).some((w) => w.status === 'draft');
  const itemsAttached = (listPublic.data || []).every((w) => Array.isArray(w.items));
  run('GET /api/release-windows publico oculta drafts y adjunta items', async () => [listPublic.status === 200 && !hasDraftPublic && itemsAttached, `draftsVisibles=${hasDraftPublic} items=${itemsAttached}`]);
  await results[6].promise;

  const listAdmin = await call('GET', '/api/release-windows?include_all=1', { token });
  const hasDraftAdmin = (listAdmin.data || []).some((w) => w.status === 'draft');
  run('GET /api/release-windows?include_all=1 admin ve drafts', async () => [listAdmin.status === 200 && hasDraftAdmin, `drafts=${hasDraftAdmin}`]);
  await results[7].promise;

  const orderId = `smoke-order-${suffix}`;
  const order = await call('POST', '/api/orders', { body: { id: orderId, customer_name: 'Smoke', customer_phone: '3000000000', pickup_day: pickupDay, items: { [flavorId]: 2 }, combos: [], total: 16000, notes: 'smoke' } });
  run('POST /api/orders pedido programado 201', async () => [order.status === 201 && order.data?.id === orderId, `status=${order.status} body=${JSON.stringify(order.data).slice(0, 300)}`]);
  await results[8].promise;

  const listAfter = await call('GET', '/api/release-windows');
  const sold = (listAfter.data || []).find((w) => w.id === openWin.data?.id)?.items?.find((it) => it.flavor_id === flavorId)?.units_sold;
  run('stock decrementa units_sold a 2', async () => [sold === 2, `units_sold=${sold}`]);
  await results[9].promise;

  const dup = await call('POST', '/api/orders', { body: { id: orderId, customer_name: 'Smoke', customer_phone: '3000000000', pickup_day: pickupDay, items: { [flavorId]: 2 }, combos: [], total: 16000 } });
  run('POST /api/orders duplicado 409', async () => [dup.status === 409, `status=${dup.status}`]);
  await results[10].promise;

  const ordersAdmin = await call('GET', '/api/orders', { token });
  run('GET /api/orders admin 200', async () => [ordersAdmin.status === 200 && Array.isArray(ordersAdmin.data), `status=${ordersAdmin.status}`]);
  await results[11].promise;

  const badOrder = await call('POST', '/api/orders', { body: { id: `smoke-over-${suffix}`, customer_name: 'S', customer_phone: '3', pickup_day: pickupDay, items: { [flavorId]: 999 }, combos: [], total: 1000 } });
  run('POST /api/orders stock insuficiente 400 y no crea pedido', async () => [badOrder.status === 400 && badOrder.data?.error === 'insufficient_stock', `status=${badOrder.status} err=${badOrder.data?.error}`]);
  await results[12].promise;

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 29, 63, 242, 83, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 60, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), `smoke-${suffix}.png`);
  fd.append('category', 'smoke');
  const upload = await call('POST', '/api/uploads', { token, form: fd });
  const upUrl = upload.data?.files?.[0]?.url;
  run('POST /api/uploads admin 201', async () => [upload.status === 201 && !!upUrl, `status=${upload.status} body=${JSON.stringify(upload.data).slice(0, 300)}`]);
  await results[13].promise;

  if (upUrl) {
    const served = await call('GET', upUrl, { raw: true });
    const servedCt = served.res.headers.get('content-type');
    run('GET uploads file 200 image/png', async () => [served.status === 200 && servedCt === 'image/png', `status=${served.status} ct=${servedCt}`]);
    await results[14].promise;
  }

  const uploadNoAuth = await call('POST', '/api/uploads', { form: (() => { const f = new FormData(); f.append('files', new Blob([png], { type: 'image/png' }), 'x.png'); return f; })() });
  run('POST /api/uploads sin token 401', async () => [uploadNoAuth.status === 401, `status=${uploadNoAuth.status}`]);
  await results[15].promise;
}

const metricsNoAuth = await call('GET', '/api/metrics');
run('GET /api/metrics sin token 401', async () => [metricsNoAuth.status === 401, `status=${metricsNoAuth.status}`]);
await results[results.length - 1].promise;

const landing = await call('GET', '/', { raw: true });
const landingCsp = landing.res.headers.get('content-security-policy');
const landingHsts = landing.res.headers.get('strict-transport-security');
run('GET / 200 con CSP y HSTS', async () => [landing.status === 200 && !!landingCsp && !!landingHsts, `status=${landing.status} csp=${!!landingCsp} hsts=${landingHsts}`]);
await results[results.length - 1].promise;

const manage = await call('GET', '/manage.html', { raw: true });
run('GET /manage.html 200', async () => [manage.status === 200, `status=${manage.status}`]);
await results[results.length - 1].promise;

const head = await call('HEAD', '/api/health', { raw: true });
run('HEAD /api/health 200', async () => [head.status === 200, `status=${head.status}`]);
await results[results.length - 1].promise;

const opt = await call('OPTIONS', '/api/public', { raw: true });
run('OPTIONS /api/public 204', async () => [opt.status === 204, `status=${opt.status}`]);
await results[results.length - 1].promise;

const spa = await call('GET', '/ruta-que-no-existe', { raw: true });
run('GET ruta inexistente cae a index.html (SPA fallback)', async () => [spa.status === 200, `status=${spa.status}`]);
await results[results.length - 1].promise;

console.log(`\n${pass} PASS / ${fail} FAIL (base ${BASE})`);
process.exit(fail === 0 ? 0 : 1);
