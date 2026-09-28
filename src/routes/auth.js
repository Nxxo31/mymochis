import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';
import { hashPassword, verifyPassword, signJwt } from '../auth.js';

const router = Router();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const failLog = new Map();

function getFails(ip) {
  const now = Date.now();
  const entry = failLog.get(ip);
  if (!entry) return { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    failLog.delete(ip);
    return { count: 0, firstAt: now, blockedUntil: 0 };
  }
  return entry;
}

function recordFail(ip) {
  const now = Date.now();
  const entry = getFails(ip);
  const count = entry.count + 1;
  const blockedUntil = count >= LOGIN_MAX_FAILS ? now + LOGIN_WINDOW_MS : 0;
  failLog.set(ip, { count, firstAt: entry.firstAt || now, blockedUntil });
  return { count, blockedUntil };
}

function clearFails(ip) {
  failLog.delete(ip);
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a || '', 'hex');
    const bb = Buffer.from(b || '', 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

router.post('/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  if (typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'bad_request', message: 'email inválido' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'bad_request', message: 'password debe tener al menos 8 caracteres' });
  if (password.length > 200) return res.status(400).json({ error: 'bad_request', message: 'password demasiado largo' });
  if (name && (typeof name !== 'string' || name.length > 120)) return res.status(400).json({ error: 'bad_request', message: 'name inválido' });

  const emailLower = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) return res.status(400).json({ error: 'bad_request', message: 'formato de email inválido' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
  if (existing) return res.status(409).json({ error: 'email_taken', message: 'Ese email ya está registrado' });

  const { salt, hash } = hashPassword(password);
  const result = db.prepare(
    "INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, 'customer')"
  ).run(emailLower, hash, salt, name || null);

  const userId = result.lastInsertRowid;
  const token = signJwt({ sub: userId, email: emailLower, role: 'customer' });
  res.status(201).json({ token, user: { id: userId, email: emailLower, name: name || null, role: 'customer' } });
});

router.post('/login', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const entry = getFails(ip);
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
    const wait = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', wait);
    return res.status(429).json({ error: 'too_many_attempts', message: `Demasiados intentos. Espera ${wait}s.` });
  }

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'bad_request', message: 'tipos inválidos' });

  const user = db.prepare('SELECT id, email, password_hash, password_salt, name, role FROM users WHERE email = ?').get(email.toLowerCase().trim());

  const fakeHash = '0'.repeat(64);
  const storedHash = user?.password_hash || fakeHash;
  const storedSalt = user?.password_salt || '0'.repeat(32);
  const valid = verifyPassword(password, storedSalt, storedHash);

  if (!user || !valid) {
    const { count, blockedUntil } = recordFail(ip);
    const payload = { error: 'invalid_credentials', message: 'Email o clave incorrectos' };
    if (blockedUntil) {
      const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
      res.setHeader('Retry-After', wait);
      payload.message = `Demasiados intentos. Espera ${wait}s.`;
      payload.error = 'too_many_attempts';
      payload.attempts = count;
      return res.status(429).json(payload);
    }
    payload.attempts = count;
    return res.status(401).json(payload);
  }

  clearFails(ip);
  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export default router;