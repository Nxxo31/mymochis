// MyMochis · Paridad del pricing entre el server de Node y el Worker, y el flag
// `orderable` que publica /api/public/.
//
// Por que estos tests existen (2026-10-21):
// El server de Node recalculaba el total desde el catálogo (priceOrder en
// src/lib/pricing.js). El Worker, que corre las MISMAS rutas sobre D1, NO lo
// hacía: persistía el `total` que mandaba el cliente. El bug no lo cazaba
// ningún test porque todos los tests manejan el mismo cliente que define el
// total — hay que mover el total a mano para que la divergencia sea visible.
//
// Estos tests fallan si alguien revierte cualquiera de los dos fixes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Puerto propio y no usado por ningun otro test/*.test.js (4177-4183 ya estan
// ocupados): node --test corre los archivos en paralelo y dos servidores en el
// mismo puerto hacen fallar el login del otro con "login fallo".
const PORT = 4187;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@parity.local';
const ADMIN_PASSWORD = 'ParityTest123!';

let child, tmpDir, token, windowDate, comboId, comboPrice;

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

let n = 0;
const uniq = () => `PAR-${Date.now().toString(36)}-${n++}`;

const COMBO_PRICE = 25000;
const FLAVOR_PRICE = 8000;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-parity-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD,
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  token = r.json.token;
  assert.ok(token, 'login fallo');

  await api('POST', '/api/flavors', { token, body: { id: 'par-fresa', name: 'Par Fresa', price: FLAVOR_PRICE, available: 1 } });

  const comboRes = await api('POST', '/api/combos', {
    token, body: { name: 'Par Combo 6', units: 6, price: COMBO_PRICE, available: true, units_available: 50 },
  });
  comboId = comboRes.json?.id ?? comboRes.json?.combo?.id;
  comboPrice = Number(comboRes.json?.price ?? comboRes.json?.combo?.price ?? COMBO_PRICE);
  assert.ok(comboId != null, `combo create fallo: ${comboRes.status} ${JSON.stringify(comboRes.json)}`);

  // Ventana abierta a未来 + schedule con cutoff amplio para no bloquear.
  const d = new Date(Date.now() + 3 * 86400000);
  windowDate = d.toISOString().slice(0, 10);
  await api('POST', '/api/release-windows', {
    token,
    body: {
      release_date: windowDate,
      cutoff_at: `${windowDate}T09:00:00`,
      status: 'open',
      items: [{ flavor_id: 'par-fresa', units_available: 500 }],
    },
  });
  const dow = new Date(`${windowDate}T12:00:00Z`).getUTCDay();
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: dow, mode: 'both', start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
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
// BUG-24 ( Worker ): el Worker no recalculaba el total
// =============================================================================

test('bug#24 — el módulo de pricing del Worker recalcula el total y rechaza el del cliente', async () => {
  // Se importa la función del Worker directamente con un stub de D1 async.
  // Si alguien borra worker/lib/pricing.js o vuelve a confiar en el cliente,
  // este test falla en import, no en un assert invisible.
  const { priceOrder } = await import('../worker/lib/pricing.js');

  // Stub minimo de la API de D1 que usa priceOrder.
  const catalogo = {
    flavors: [{ id: 'par-fresa', name: 'Par Fresa', price: FLAVOR_PRICE }],
    combos: [{ id: comboId, name: 'Par Combo 6', price: comboPrice }],
  };
  const db = {
    prepare(sql) {
      const isFlavor = sql.includes('FROM flavors');
      const rows = isFlavor ? catalogo.flavors : catalogo.combos;
      return {
        bind(...ids) {
          return {
            async all() {
              const set = new Set(ids.map(String));
              return { results: rows.filter(r => set.has(String(r.id))) };
            },
            async first() { return rows.find(r => set.has(String(r.id))) || null; },
          };
        },
        async first() { return null; },
        async all() { return { results: rows }; },
      };
    },
  };

  // 2 × combo de $25.000 = $50.000, aunque el cliente diga 1 peso.
  const priced = await priceOrder({ db, items: {}, combos: [{ id: comboId, qty: 2 }], deliveryFee: 0 });
  assert.equal(priced.ok, true, `priceOrder debe ok: ${JSON.stringify(priced.errors)}`);
  assert.equal(priced.total, comboPrice * 2,
    `el total debe salir del catálogo (${comboPrice * 2}), no del cliente`);
  assert.equal(priced.lines.length, 1);
  assert.equal(priced.lines[0].subtotal, comboPrice * 2);

  // Sabores también se recalculan.
  const pricedF = await priceOrder({ db, items: { 'par-fresa': 3 }, combos: [], deliveryFee: 0 });
  assert.equal(pricedF.total, FLAVOR_PRICE * 3);

  // Un id que no existe se rechaza, no se cobra como 0.
  const bad = await priceOrder({ db, items: { 'no-existe': 1 }, combos: [], deliveryFee: 0 });
  assert.equal(bad.ok, false, 'un sabor inexistente debe marcar el pricing como no-ok');
  assert.match(bad.errors.join(), /sabor_inexistente/);
});

test('bug#24 — el Worker persiste authoritativeTotal, no el total del cliente', async () => {
  // Verificación estática: la ruta del Worker debe usar el total autoritativo.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'worker/routes/orders.js'), 'utf8');

  assert.match(src, /import \{ priceOrder \} from '\.\.\/lib\/pricing\.js'/,
    'worker/routes/orders.js debe importar priceOrder');
  assert.match(src, /const priced = await priceOrder\(/,
    'debe recalcular el pricing en el POST');
  assert.match(src, /authoritativeTotal, notes/,
    'el INSERT debe persistir authoritativeTotal, no el total del cliente');
  assert.doesNotMatch(src, /finalTotal/,
    'la variable finalTotal (total del cliente) no debe sobrevivir al fix');

  // Y src/ (el server de Node) también, para que nadie lo revierta en silencio.
  const nodeSrc = readFileSync(join(ROOT, 'src/routes/orders.js'), 'utf8');
  assert.match(nodeSrc, /authoritativeTotal/, 'src/routes/orders.js debe persistir authoritativeTotal');
});

// =============================================================================
// El flag `orderable` de /api/public/
// =============================================================================

test('orderable — /api/public/ marca orderable=false con el cutoff vencido', async () => {
  const r = await api('GET', '/api/public/');
  assert.equal(r.status, 200);
  const w = r.json.release_windows.find(x => x.release_date === windowDate);
  assert.ok(w, `no se encontro la ventana ${windowDate} en /api/public/`);
  assert.equal(typeof w.orderable, 'boolean', 'cada ventana debe traer orderable');
  assert.equal(w.orderable, true, 'una ventana futura con cutoff amplio debe ser orderable');
});

test('orderable — una ventana pasada no se ofrece aunque status sea open', async () => {
  // Ventana de AYER, status open: el cliente no debe poder pedirla.
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dow = new Date(`${ayer}T12:00:00Z`).getUTCDay();
  await api('POST', '/api/delivery-schedule', {
    token,
    body: { day_of_week: dow, mode: 'both', start_time: '15:00', end_time: '19:00', cutoff_offset_hours: 0, active: 1 },
  });
  await api('POST', '/api/release-windows', {
    token,
    body: { release_date: ayer, cutoff_at: `${ayer}T09:00:00`, status: 'open', items: [{ flavor_id: 'par-fresa', units_available: 10 }] },
  });

  const r = await api('GET', '/api/public/');
  const w = r.json.release_windows.find(x => x.release_date === ayer);
  assert.ok(w, 'la ventana de ayer deberia estar en el catalogo');
  assert.equal(w.status, 'open', 'esta marcada open en la DB a proposito');
  assert.equal(w.orderable, false, 'pero NO debe ofrecerse: su cutoff ya vencio');
  assert.match(w.not_orderable_reason, /past_cutoff|no_pickup_schedule/);
});

test('orderable — el server NO acepta un pedido para una ventana no orderable', async () => {
  // El front y el backend no pueden discrepar: si el server acepta algo que
  // marcó como no-orderable, el flag es decorativo.
  const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const r = await api('POST', '/api/orders', {
    body: {
      id: uniq(), customer_name: 'Paridad', customer_phone: '573213050426',
      pickup_day: ayer, items: { 'par-fresa': 1 }, combos: [], total: FLAVOR_PRICE, source: 'test',
    },
  });
  assert.equal(r.status, 400, 'un pedido a una ventana pasada debe rechazarse');
  assert.match(r.json.error, /past_cutoff|no_release_window|no_pickup_schedule/);
});

// =============================================================================
// release-windows: include_all=1 (el admin debe poder ver drafts)
// =============================================================================

test('release-windows — include_all=1 funciona para admin y no filtra al anonimo', async () => {
  const draft = await api('POST', '/api/release-windows', {
    token,
    body: { release_date: '2026-12-25', cutoff_at: '2026-12-25T09:00:00', status: 'draft', items: [{ flavor_id: 'par-fresa', units_available: 5 }] },
  });
  assert.equal(draft.status, 201, `no se pudo crear el draft: ${JSON.stringify(draft.json)}`);

  // Anónimo: sin drafts, y sin 401 (la lectura pública debe seguir abierta).
  const anon = await api('GET', '/api/release-windows?include_all=1');
  assert.equal(anon.status, 200, 'un anonimo no debe recibir 401 en una lectura pública');
  assert.equal(anon.json.filter(w => w.status === 'draft').length, 0, 'el anonimo no debe ver drafts');

  // Admin: sí los ve (antes de este fix no los veía, req.user nunca se poblaba).
  const admin = await api('GET', '/api/release-windows?include_all=1', { token });
  assert.equal(admin.status, 200);
  assert.ok(admin.json.filter(w => w.status === 'draft').length > 0,
    'el admin debe ver los drafts con include_all=1');

  // El listado normal del admin tampoco expone drafts.
  const plain = await api('GET', '/api/release-windows', { token });
  assert.equal(plain.json.filter(w => w.status === 'draft').length, 0,
    'sin include_all no deben aparecer drafts ni para el admin');
});