import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createHmac } from 'node:crypto';

const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.NEXOMOCHIS_JWT_SECRET;
const JWT_SECRET_EFFECTIVE = JWT_SECRET || (IS_PROD ? null : 'dev-secret-change-in-production-please');
if (!JWT_SECRET_EFFECTIVE) {
  throw new Error('NEXOMOCHIS_JWT_SECRET is required in production');
}
const JWT_TTL_SECONDS = Number(process.env.NEXOMOCHIS_JWT_TTL_SECONDS || (IS_PROD ? 12 * 60 * 60 : 7 * 24 * 60 * 60));
if (!Number.isFinite(JWT_TTL_SECONDS) || JWT_TTL_SECONDS < 300 || JWT_TTL_SECONDS > 30 * 24 * 60 * 60) {
  throw new Error('NEXOMOCHIS_JWT_TTL_SECONDS must be between 300 and 2592000');
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64);
  const target = Buffer.from(hash, 'hex');
  if (candidate.length !== target.length) return false;
  return timingSafeEqual(candidate, target);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + JWT_TTL_SECONDS }));
  const sig = b64url(createHmac('sha256', JWT_SECRET_EFFECTIVE).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(createHmac('sha256', JWT_SECRET_EFFECTIVE).update(`${header}.${body}`).digest());
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'unauthorized', message: 'Token inválido o expirado' });
  req.user = payload;
  next();
}

export function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Autenticación requerida' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Rol insuficiente para esta operación' });
    }
    next();
  };
}