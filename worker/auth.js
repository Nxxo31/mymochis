const PBKDF2_ITERATIONS_DEFAULT = 210000;
// Cloudflare Workers cap PBKDF2 at 100k iterations. Keep that ceiling here so
// dev doesn't generate hashes the worker can't verify.
const PBKDF2_MAX_OK = 100000;

export function pbkdf2Iterations(env) {
  const n = Number(env?.NEXOMOCHIS_PBKDF2_ITERATIONS || PBKDF2_ITERATIONS_DEFAULT);
  if (!Number.isInteger(n) || n !== Math.trunc(n)) return PBKDF2_ITERATIONS_DEFAULT;
  if (n > PBKDF2_MAX_OK) return PBKDF2_MAX_OK;
  if (n < 10000) return 10000;
  return n;
}

let cachedKey = null;
let cachedSecret = null;

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function b64url(buf) {
  let s = typeof buf === 'string' ? btoa(buf) : btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeText(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
function timingSafeEqHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getJwtKey(env) {
  const isProd = env.ENVIRONMENT === 'production';
  const secret = env.NEXOMOCHIS_JWT_SECRET || (isProd ? null : 'dev-secret-change-in-production-please');
  if (!secret) throw new Error('NEXOMOCHIS_JWT_SECRET is required in production');
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  cachedSecret = secret;
  return cachedKey;
}

export function jwtTtlSeconds(env) {
  const t = Number(env.NEXOMOCHIS_JWT_TTL_SECONDS || (env.ENVIRONMENT === 'production' ? 43200 : 604800));
  if (!Number.isFinite(t) || t < 300 || t > 2592000) throw new Error('NEXOMOCHIS_JWT_TTL_SECONDS must be 300..2592000');
  return t;
}

export async function hashPassword(password, env) {
  const iterations = pbkdf2Iterations(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256
  );
  return { salt: bytesToHex(salt), hash: `pbkdf2$${iterations}$${bytesToHex(bits)}` };
}

export async function verifyPassword(password, salt, storedHash) {
  try {
    if (String(storedHash).startsWith('pbkdf2$')) {
      const [, iterStr, hashHex] = String(storedHash).split('$');
      const iterations = Number(iterStr);
      if (!iterations || !hashHex || !salt) return false;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: hexToBytes(salt), iterations, hash: 'SHA-256' }, key, 256
      );
      return timingSafeEqHex(bytesToHex(bits), hashHex);
    }
    return false;
  } catch {
    return false;
  }
}

export async function signJwt(payload, env) {
  const key = await getJwtKey(env);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + jwtTtlSeconds(env) }));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJwt(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const key = await getJwtKey(env);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    const sigPadded = sigB64 + '='.repeat((4 - (sigB64.length % 4)) % 4);
    const sig = Uint8Array.from(atob(sigPadded), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecodeText(parts[1]));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const run = async () => {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const payload = await verifyJwt(token, req.env);
    if (!payload) {
      res.status(401).json({ error: 'unauthorized', message: 'Token invalido o expirado' });
      return;
    }
    req.user = payload;
    await next();
  };
  return run();
}

export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized', message: 'Autenticacion requerida' });
      return Promise.resolve();
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden', message: 'Rol insuficiente para esta operacion' });
      return Promise.resolve();
    }
    return next();
  };
}
