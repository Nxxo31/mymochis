// MyMochis · Tests del proveedor google_maps y del endpoint de configuración del mapa
//
// El foco NO es "el mapa se ve bien" — es que el riesgo quede demostrado como
// cerrado: la API key del navegador sale SOLO por el endpoint admin que la
// necesita, nunca por el listado genérico de credenciales, y en la base de
// datos vive cifrada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4185;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@maps.test';
const ADMIN_PASSWORD = 'MapsTest123!';
const VAULT_KEY = 'b'.repeat(64);

const BROWSER_KEY = 'test-browser-key-fixture-0001';
const MAP_ID = '1a2b3c4d5e6f7g8h9i0j';

let child, tmpDir, adminToken;

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

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, text: await res.text().catch(() => '') };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-maps-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXOMOCHIS_DB_PATH: join(tmpDir, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
      ADMIN_EMAIL, ADMIN_PASSWORD,
      NEXOMOCHIS_VAULT_KEY: VAULT_KEY,
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitReady();
  const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  adminToken = r.json.token;
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(r => child.once('exit', r));
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// =============================================================================

test('vault — el proveedor google_maps existe con sus campos y la guía en español', async () => {
  const r = await api('GET', '/api/credentials/status', { token: adminToken });
  assert.equal(r.status, 200);
  const maps = r.json.providers.find(p => p.id === 'google_maps');
  assert.ok(maps, 'google_maps debe aparecer en /status');
  assert.deepEqual(maps.fields, ['browser_key', 'map_id']);
  assert.match(maps.hint, /Google Cloud/i);
  assert.match(maps.hint, /Maps JavaScript API/);
  assert.match(maps.hint, /Places API/);
  assert.match(maps.hint, /Referentes HTTP/);
  assert.match(maps.hint, /Restricciones de API/);
  assert.match(maps.hint, /facturaci/i);
  assert.ok(maps.docs.startsWith('https://'), 'debe enlazar la documentación oficial');
});

test('maps-config — es admin-only (401 sin token, 403 para cliente)', async () => {
  assert.equal((await api('GET', '/api/credentials/maps-config')).status, 401);
  const reg = await api('POST', '/api/auth/register', {
    body: { email: 'cliente@maps.test', password: 'ClienteTest123!', name: 'Cliente' },
  });
  const custToken = reg.json?.token;
  if (custToken) {
    assert.equal((await api('GET', '/api/credentials/maps-config', { token: custToken })).status, 403);
  }
});

test('maps-config — sin key guardada responde 200 con razón clara (no 500)', async () => {
  const r = await api('GET', '/api/credentials/maps-config', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.ready, false);
  assert.equal(r.json.browser_key, null);
  assert.equal(r.json.map_id, null);
  assert.ok(r.json.reason && r.json.reason.length > 10, 'debe explicar por qué no hay mapa');
});

test('vault — guarda browser_key y map_id cifrados', async () => {
  const saved = await api('POST', '/api/credentials', {
    token: adminToken,
    body: { provider: 'google_maps', field: 'browser_key', value: BROWSER_KEY },
  });
  assert.equal(saved.status, 200, saved.text);
  const savedMap = await api('POST', '/api/credentials', {
    token: adminToken,
    body: { provider: 'google_maps', field: 'map_id', value: MAP_ID },
  });
  assert.equal(savedMap.status, 200, savedMap.text);

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(tmpDir, 'test.db'));
  const row = db.prepare('SELECT * FROM merchant_credentials WHERE provider = ? AND field = ?')
    .get('google_maps', 'browser_key');
  assert.ok(row, 'la fila debe existir');
  assert.ok(!String(row.ciphertext).includes('test-browser-key-fixture'), 'la key no puede estar en claro en ciphertext');
  assert.ok(row.iv && row.tag, 'iv y tag presentes (AES-GCM)');
  const secrets = db.prepare('SELECT * FROM app_secrets').all();
  assert.ok(secrets.every(s => !String(s.value).includes(VAULT_KEY)), 'la master key no está en la DB');
  db.close();
});

test('maps-config — devuelve SOLO la browser key y el map_id del mapa', async () => {
  await api('POST', '/api/credentials', {
    token: adminToken,
    body: { provider: 'bancolombia', field: 'client_secret', value: 'test-secret-fixture-0002' },
  });
  const r = await api('GET', '/api/credentials/maps-config', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.ready, true);
  assert.equal(r.json.browser_key, BROWSER_KEY);
  assert.equal(r.json.map_id, MAP_ID);
  assert.ok(!r.text.includes('ABCDEF1234567890'), 'no puede filtrar secretos de otros proveedores');
  assert.ok(!r.text.includes('test-secret-fixture'), 'no puede filtrar secretos de otros proveedores');
});

test('RISGO — el listado genérico de credenciales sigue sin devolver la browser key', async () => {
  const list = await api('GET', '/api/credentials', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(BROWSER_KEY), 'GET /api/credentials no debe filtrar la browser key');
  assert.ok(!list.text.includes('test-browser-key-fixture'), 'ni siquiera un fragmento');
  for (const c of list.json.credentials) {
    assert.equal(c.value, null, 'el campo value debe venir null por diseño');
  }
});

test('readiness — google_maps queda completo solo con la browser key (map_id es opcional)', async () => {
  const r = await api('GET', '/api/credentials/readiness', { token: adminToken });
  assert.equal(r.status, 200);
  const maps = r.json.providers.find(p => p.provider === 'google_maps');
  assert.ok(maps);
  assert.equal(maps.configured, true, 'con browser_key guardado ya está completo');
  assert.deepEqual(maps.missing, []);
});

test('RISGO — sin NEXOMOCHIS_VAULT_KEY el endpoint responde 200 con razón (no 500)', async () => {
  const port2 = 4186;
  const dir2 = mkdtempSync(join(tmpdir(), 'mymochis-maps-novault-'));
  const c2 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port2),
      NEXOMOCHIS_DB_PATH: join(dir2, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(dir2, 'uploads'),
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
      NEXOMOCHIS_VAULT_KEY: '',
      MYMOCHIS_NO_WORKERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port2}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    const login = await fetch(`http://127.0.0.1:${port2}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }).then(r => r.json());

    const res = await fetch(`http://127.0.0.1:${port2}/api/credentials/maps-config`, {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    assert.equal(res.status, 200, 'sin master key debe responder 200, no 500');
    const body = await res.json();
    assert.equal(body.ready, false);
    assert.equal(body.browser_key, null);
    assert.match(body.reason, /NEXOMOCHIS_VAULT_KEY/);
  } finally {
    if (c2.exitCode === null) {
      c2.kill();
      await new Promise(r => c2.once('exit', r));
    }
    rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('CSP — habilita Google Maps y sigue sin comodines ni frames', async () => {
  const res = await fetch(`${BASE}/manage.html`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src[^;]*https:\/\/maps\.googleapis\.com/);
  assert.match(csp, /connect-src[^;]*https:\/\/maps\.googleapis\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('*'), 'la CSP no debe usar comodines');
  assert.ok(!/script-src[^;]*\*/.test(csp), 'script-src no debe usar comodines');
});

test('CSP — el archivo _headers de Cloudflare coincide con el del servidor', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
  const line = raw.split(/\r?\n/).find(l => l.includes('Content-Security-Policy:'));
  assert.ok(line, '_headers debe declarar Content-Security-Policy');
  assert.match(line, /script-src[^;]*https:\/\/maps\.googleapis\.com/);
  assert.match(line, /connect-src[^;]*https:\/\/maps\.googleapis\.com/);
  assert.match(line, /frame-ancestors 'none'/);
  assert.ok(!line.includes('*'), 'la CSP de _headers no debe usar comodines');
});

test('el HTML del panel no contiene ninguna API key de Google Maps', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['public/manage.html', 'public/tienda.html', 'public/js/maps-picker.js']) {
    const raw = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!raw.includes('AIza'), `${file} no debe traer una API key embebida`);
  }
});
