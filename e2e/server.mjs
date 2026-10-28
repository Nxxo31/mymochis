// Servidor para el E2E: DB temporal propia, puerto propio, admin sembrado.
// Nunca toca data/mymochis.db ni el server de desarrollo.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.E2E_PORT || '4210';

const tmpDir = mkdtempSync(join(tmpdir(), 'mymochis-e2e-'));
const dbPath = join(tmpDir, 'e2e.db');

const env = {
  ...process.env,
  PORT,
  NODE_ENV: 'test',
  NEXOMOCHIS_DB_PATH: dbPath,
  NEXOMOCHIS_UPLOAD_DIR: join(tmpDir, 'uploads'),
  NEXOMOCHIS_JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
  ADMIN_EMAIL: 'admin@e2e.test',
  ADMIN_PASSWORD: 'E2eTest123!',
  NEXOMOCHIS_CORS: `http://localhost:${PORT}`,
};

/**
 * El E2E necesita un catalogo real: sin sabores la landing oculta las
 * secciones de productos, combos y horarios (por diseno) y los tests no
 * tendrian nada sobre que verificar. Sembramos el catalogo de demo en la
 * DB temporal ANTES de levantar el server.
 *
 * El seed y el server NUNCA pueden coexistir: ambos abren la misma DB y el
 * perdedor choca con el lock de SQLite ('database is locked').
 */
function seed() {
  return new Promise((resolve, reject) => {
    const s = spawn(process.execPath, ['scripts/seed-demo.mjs'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    s.stderr.on('data', (d) => { err += String(d); });
    s.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed fallo (${code}): ${err.slice(-400)}`))));
    s.on('error', reject);
  });
}

await seed();

const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

child.stderr.on('data', (d) => {
  const s = String(d);
  if (/error|Error|EADDRINUSE/.test(s)) process.stderr.write(`[e2e server] ${s}`);
});

function cleanup() {
  try { child.kill(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

child.on('exit', (code) => process.exit(code ?? 0));
