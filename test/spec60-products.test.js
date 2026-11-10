// MyMochis · Spec 60 · Marketplace UI: API de productos y composición de combos
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4182;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@spec60.local';
const ADMIN_PASSWORD = 'Spec60Test123!';

let child, tmpDir, token;

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
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  if (res.status >= 500) console.error(`SERVER ERROR ${res.status} ${method} ${path}:`, JSON.stringify(json));
  return { status: res.status, json };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-spec60-'));
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
  // Reintento de login: el admin se seeda durante init, puede tardar un poco
  let loginOk = false;
  for (let i = 0; i < 20 && !loginOk; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (r.status === 200 && r.json.token) {
      token = r.json.token;
      loginOk = true;
    } else {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  assert.ok(loginOk, 'login fallo tras reintentos');
});

after(() => {
  if (child) child.kill();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('spec60 · crear producto con tags, status y punto focal', async () => {
  const res = await api('POST', '/api/products', {
    token,
    body: {
      id: 'spec60-fresa',
      name: 'Mochi de Fresa',
      description: 'Sabor fresa natural',
      price: 8000,
      tags: ['fresco', 'sin-lactosa', 'top-ventas'],
      status: 'published',
      focal_point_x: 30,
      focal_point_y: 70,
      available: 1,
    },
  });
  assert.strictEqual(res.status, 201, `create fallo: ${res.status} ${JSON.stringify(res.json)}`);
  assert.strictEqual(res.json.id, 'spec60-fresa');
  assert.deepStrictEqual(res.json.tags, ['fresco', 'sin-lactosa', 'top-ventas']);
  assert.strictEqual(res.json.status, 'published');
  assert.strictEqual(res.json.focal_point_x, 30);
  assert.strictEqual(res.json.focal_point_y, 70);
});

test('spec60 · listar productos con filtro de tag y status', async () => {
  // Segundo producto borrador con tag distinto
  await api('POST', '/api/products', {
    token,
    body: {
      id: 'spec60-chocolate',
      name: 'Mochi de Chocolate',
      price: 9000,
      tags: ['vegano'],
      status: 'draft',
      available: 1,
    },
  });

  const all = await api('GET', '/api/products', { token });
  if (all.status !== 200) console.error('GET /api/products error:', all.status, JSON.stringify(all.json));
  assert.strictEqual(all.status, 200);
  assert.ok(all.json.some(p => p.id === 'spec60-fresa'));
  assert.ok(all.json.some(p => p.id === 'spec60-chocolate'));

  const published = await api('GET', '/api/products?status=published', { token });
  assert.strictEqual(published.status, 200);
  assert.ok(published.json.every(p => p.status === 'published'));
  assert.ok(published.json.some(p => p.id === 'spec60-fresa'));
  assert.ok(!published.json.some(p => p.id === 'spec60-chocolate'));

  const tagged = await api('GET', '/api/products?tag=fresco', { token });
  assert.strictEqual(tagged.status, 200);
  assert.ok(tagged.json.some(p => p.id === 'spec60-fresa'));
});

test('spec60 · actualizar producto (cambiar status a draft)', async () => {
  const res = await api('PUT', '/api/products/spec60-fresa', {
    token,
    body: { status: 'draft', price: 8500 },
  });
  assert.strictEqual(res.status, 200, `update fallo: ${res.status}`);
  assert.strictEqual(res.json.status, 'draft');
  assert.strictEqual(res.json.price, 8500);

  const get = await api('GET', '/api/products/spec60-fresa', { token });
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.json.status, 'draft');
  assert.strictEqual(get.json.price, 8500);
});

test('spec60 · crear combo con items (composición de productos)', async () => {
  const combo = await api('POST', '/api/combos', {
    token,
    body: {
      name: 'Combo Familiar Spec60',
      units: 6,
      price: 45000,
      available: 1,
    },
  });
  assert.strictEqual(combo.status, 201, `create combo fallo: ${combo.status}`);
  const comboId = combo.json.id;
  assert.ok(comboId, 'combo sin id');

  // Añadir items al combo
  const item1 = await api('POST', `/api/combos/${comboId}/items`, {
    token,
    body: { flavor_id: 'spec60-fresa', qty: 4 },
  });
  assert.strictEqual(item1.status, 201, `add item fallo: ${item1.status}`);

  const item2 = await api('POST', `/api/combos/${comboId}/items`, {
    token,
    body: { flavor_id: 'spec60-chocolate', qty: 2 },
  });
  assert.strictEqual(item2.status, 201, `add item2 fallo: ${item2.status}`);

  // Obtener items del combo
  const items = await api('GET', `/api/combos/${comboId}/items`, { token });
  assert.strictEqual(items.status, 200);
  assert.strictEqual(items.json.length, 2);
  const fresa = items.json.find(i => i.flavor_id === 'spec60-fresa');
  const choco = items.json.find(i => i.flavor_id === 'spec60-chocolate');
  assert.ok(fresa, 'item fresa no encontrado');
  assert.ok(choco, 'item chocolate no encontrado');
  assert.strictEqual(fresa.qty, 4);
  assert.strictEqual(choco.qty, 2);
  assert.strictEqual(fresa.flavor_name, 'Mochi de Fresa');
  assert.strictEqual(choco.flavor_name, 'Mochi de Chocolate');

  // Eliminar un item
  const del = await api('DELETE', `/api/combos/${comboId}/items/${fresa.id}`, { token });
  assert.strictEqual(del.status, 200, `delete item fallo: ${del.status}`);

  const itemsAfter = await api('GET', `/api/combos/${comboId}/items`, { token });
  assert.strictEqual(itemsAfter.json.length, 1);
  assert.strictEqual(itemsAfter.json[0].flavor_id, 'spec60-chocolate');
});

test('spec60 · duplicar item en combo da 409', async () => {
  const combo = await api('POST', '/api/combos', {
    token,
    body: { name: 'Combo Dup Spec60', units: 4, price: 30000, available: 1 },
  });
  const comboId = combo.json.id;

  await api('POST', `/api/combos/${comboId}/items`, {
    token,
    body: { flavor_id: 'spec60-fresa', qty: 1 },
  });

  const dup = await api('POST', `/api/combos/${comboId}/items`, {
    token,
    body: { flavor_id: 'spec60-fresa', qty: 1 },
  });
  assert.strictEqual(dup.status, 409, `duplicate item debería dar 409, dio ${dup.status}`);
});

test('spec60 · eliminar producto borra sus items de combo (cascade)', async () => {
  const combo = await api('POST', '/api/combos', {
    token,
    body: { name: 'Combo Cascade Spec60', units: 4, price: 30000, available: 1 },
  });
  const comboId = combo.json.id;

  await api('POST', `/api/combos/${comboId}/items`, {
    token,
    body: { flavor_id: 'spec60-fresa', qty: 1 },
  });

  const itemsBefore = await api('GET', `/api/combos/${comboId}/items`, { token });
  assert.strictEqual(itemsBefore.json.length, 1);

  await api('DELETE', '/api/products/spec60-fresa', { token });

  const itemsAfter = await api('GET', `/api/combos/${comboId}/items`, { token });
  assert.strictEqual(itemsAfter.json.length, 0, 'items deberían borrarse en cascade');
});
