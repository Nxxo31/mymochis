// MyMochis · Tests del vault de credenciales
//
// El foco NO es "el cifrado funciona" — es que el RIESGO que pidió el operador
// quede demostrado como cerrado: un secreto guardado no se puede leer por API,
// ni con el token de admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 4181;
const BASE = `http://localhost:${PORT}`;
const ADMIN_EMAIL = 'admin@vault.local';
const ADMIN_PASSWORD = 'VaultTest123!';
// Clave maestra de test: la misma forma que en prod (openssl rand -hex 32).
const VAULT_KEY = 'a'.repeat(64);

let child, tmpDir, adminToken;

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

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  const text = await res.text().catch(() => '');
  return { status: res.status, json, text };
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-vault-'));
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

const SECRET = 'sk_live_ABCDEF1234567890XYZ';

// =============================================================================

test('vault — /status reporta configurado y lista los proveedores soportados', async () => {
  const r = await api('GET', '/api/credentials/status', { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.configured, true);
  assert.ok(r.json.providers.some(p => p.id === 'bancolombia'));
  assert.ok(r.json.providers.some(p => p.id === 'nequi'));
  assert.ok(r.json.guarantees.some(g => /write-only/.test(g)));
});

test('vault — RBAC: sin token → 401; customer → 403', async () => {
  assert.equal((await api('GET', '/api/credentials')).status, 401);
  const reg = await api('POST', '/api/auth/register', {
    body: { email: 'cliente@vault.local', password: 'ClienteTest123!', name: 'Cliente' },
  });
  const custToken = reg.json?.token;
  if (custToken) {
    assert.equal((await api('GET', '/api/credentials', { token: custToken })).status, 403);
  }
});

test('vault — guarda una credencial y devuelve metadata enmascarada', async () => {
  const r = await api('POST', '/api/credentials', {
    token: adminToken,
    body: { provider: 'bancolombia', field: 'client_secret', value: SECRET },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.secret_set, true);
  assert.ok(r.json.masked.endsWith('XYZ'), `mascara debe terminar en los ultimos 4: ${r.json.masked}`);
  assert.ok(!r.json.masked.includes('ABCDEF'), 'la mascara no debe exponer el cuerpo');
});

test('RISGO 1 — la API NUNCA devuelve el secreto, ni con token de admin', async () => {
  const list = await api('GET', '/api/credentials', { token: adminToken });
  assert.equal(list.status, 200);
  // El string completo no puede aparecer en ninguna parte de la respuesta.
  assert.ok(!list.text.includes(SECRET), 'el secreto se filtro en GET /api/credentials');
  assert.ok(!list.text.includes('ABCDEF1234567890'), 'ni siquiera un fragmento');
  for (const c of list.json.credentials) {
    assert.equal(c.value, null, 'el campo value debe venir null por diseño');
    assert.equal(c.secret_set, true);
  }
});

test('RISGO 2 — no existe endpoint que devuelva un secreto concreto', async () => {
  // Un GET a cualquier ruta que "suene" a lectura de secreto debe fallar.
  for (const path of [
    '/api/credentials/bancolombia/client_secret',
    '/api/credentials/read?provider=bancolombia&field=client_secret',
    '/api/credentials/1',
    '/api/credentials/value',
    '/api/credentials/secret',
  ]) {
    const r = await api('GET', path, { token: adminToken });
    assert.notEqual(r.status, 200, `${path} no debe devolver 200`);
    assert.ok(!r.text.includes(SECRET), `${path} filtro un secreto`);
  }
});

test('vault — la DB guarda ciphertext, no el texto plano', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(tmpDir, 'test.db'));
  const row = db.prepare('SELECT * FROM merchant_credentials WHERE provider = ? AND field = ?')
    .get('bancolombia', 'client_secret');
  assert.ok(row, 'la fila debe existir');
  assert.ok(!String(row.ciphertext).includes('ABCDEF'), 'el texto plano no puede estar en ciphertext');
  assert.ok(row.iv && row.tag, 'iv y tag presentes (AES-GCM)');
  assert.equal(row.masked.endsWith('XYZ'), true);
  // Re-derivacion: la clave no está en la DB.
  const secrets = db.prepare('SELECT * FROM app_secrets').all();
  assert.ok(
    secrets.every(s => !String(s.value).includes(VAULT_KEY)),
    'la master key no debe estar en app_secrets'
  );
  db.close();
});

test('vault — el cifrado es determinístico en IV (mismo secreto, dos IV distintos)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(tmpDir, 'test.db'));
  await api('POST', '/api/credentials', {
    token: adminToken, body: { provider: 'nequi', field: 'api_key', value: SECRET },
  });
  const a = db.prepare('SELECT iv FROM merchant_credentials WHERE provider=? AND field=?').get('nequi', 'api_key');
  const b = db.prepare('SELECT iv FROM merchant_credentials WHERE provider=? AND field=?').get('nequi', 'api_key');
  assert.ok(a.iv.length === 24, 'IV de 12 bytes en hex');
  // Guardar dos veces el mismo valor genera IV distintos (no es determinista).
  const firstIv = a.iv;
  await api('POST', '/api/credentials', {
    token: adminToken, body: { provider: 'nequi', field: 'api_key', value: SECRET },
  });
  const c = db.prepare('SELECT iv FROM merchant_credentials WHERE provider=? AND field=?').get('nequi', 'api_key');
  assert.notEqual(firstIv, c.iv, 'cada escritura usa un IV fresco');
  db.close();
});

test('vault — rechaza provider o field desconocidos', async () => {
  const bad = await api('POST', '/api/credentials', {
    token: adminToken, body: { provider: 'mi-banco-de-casa', field: 'password', value: SECRET },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'UNKNOWN_PROVIDER');

  const bad2 = await api('POST', '/api/credentials', {
    token: adminToken, body: { provider: 'nequi', field: 'password_de_la_app', value: SECRET },
  });
  assert.equal(bad2.status, 400);
  assert.equal(bad2.json.error, 'UNKNOWN_FIELD');
});

test('vault — rechaza secretos demasiado cortos', async () => {
  const r = await api('POST', '/api/credentials', {
    token: adminToken, body: { provider: 'nequi', field: 'api_key', value: 'corto' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'WEAK_SECRET');
});

test('vault — el audit registra cada operación', async () => {
  const r = await api('GET', '/api/credentials/audit', { token: adminToken });
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.length > 0);
  assert.ok(r.json.entries.some(e => e.action === 'save'));
  assert.ok(r.json.entries.some(e => e.action === 'use'));
  // El audit tampoco puede contener el secreto.
  assert.ok(!r.text.includes('ABCDEF1234567890'));
});

test('vault — readiness muestra qué falta por proveedor', async () => {
  const r = await api('GET', '/api/credentials/readiness', { token: adminToken });
  assert.equal(r.status, 200);
  const bancolombia = r.json.providers.find(p => p.provider === 'bancolombia');
  assert.ok(bancolombia, 'bancolombia debe aparecer');
  // Guardamos client_secret pero no client_id → falta 1.
  assert.equal(bancolombia.configured, false);
  assert.deepEqual(bancolombia.missing, ['client_id']);
});

test('vault — borrar una credencial la quita del listado', async () => {
  const r = await api('DELETE', '/api/credentials', {
    token: adminToken, body: { provider: 'nequi', field: 'api_key' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
  const list = await api('GET', '/api/credentials', { token: adminToken });
  assert.ok(!list.json.credentials.some(c => c.provider === 'nequi' && c.field === 'api_key'));
});

test('RISGO 3 — sin NEXOMOCHIS_VAULT_KEY el vault falla cerrado (503, no guarda en claro)', async () => {
  const port2 = 4182;
  const dir2 = mkdtempSync(join(tmpdir(), 'mymochis-novault-'));
  const c2 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port2),
      NEXOMOCHIS_DB_PATH: join(dir2, 'test.db'),
      NEXOMOCHIS_UPLOAD_DIR: join(dir2, 'uploads'),
      ADMIN_EMAIL: ADMIN_EMAIL,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      NEXOMOCHIS_VAULT_KEY: '',            // <-- sin clave
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

    const save = await api2(port2, 'POST', '/api/credentials', {
      token: login.token,
      body: { provider: 'nequi', field: 'api_key', value: SECRET },
    });
    assert.equal(save.status, 503, `esperaba 503 sin vault key, dio ${save.status}`);
    assert.equal(save.json.error, 'VAULT_KEY_MISSING');

    // Y lo importante: NO se guardó nada en claro.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir2, 'test.db'));
    const rows = db.prepare('SELECT * FROM merchant_credentials').all();
    assert.equal(rows.length, 0, 'sin master key no debe existir ninguna fila de credencial');
    db.close();
  } finally {
    if (c2.exitCode === null) {
      c2.kill();
      await new Promise(r => c2.once('exit', r));
    }
    rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function api2(port, method, path, { token, body } = {}) {
  const h = {};
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, text: await res.text().catch(() => '') };
}
