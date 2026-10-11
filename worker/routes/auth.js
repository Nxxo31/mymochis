import { Router } from '../router.js';
import { hashPassword, verifyPassword, signJwt, pbkdf2Iterations } from '../auth.js';

const router = new Router();

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

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  if (typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'bad_request', message: 'email invalido' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'bad_request', message: 'password debe tener al menos 8 caracteres' });
  if (password.length > 200) return res.status(400).json({ error: 'bad_request', message: 'password demasiado largo' });
  if (name && (typeof name !== 'string' || name.length > 120)) return res.status(400).json({ error: 'bad_request', message: 'name invalido' });

  const emailLower = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) return res.status(400).json({ error: 'bad_request', message: 'formato de email invalido' });

  const existing = await req.db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
  if (existing) return res.status(409).json({ error: 'email_taken', message: 'Ese email ya esta registrado' });

  const { salt, hash } = await hashPassword(password, req.env);
  const result = await req.db.prepare(
    "INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, 'customer')"
  ).run(emailLower, hash, salt, name || null);

  const userId = result.lastInsertRowid;
  const token = await signJwt({ sub: userId, email: emailLower, role: 'customer' }, req.env);
  res.status(201).json({ token, user: { id: userId, email: emailLower, name: name || null, role: 'customer' } });
});

router.post('/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  const entry = getFails(ip);
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
    const wait = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'too_many_attempts', message: `Demasiados intentos. Espera ${wait}s.` });
  }

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'bad_request', message: 'tipos invalidos' });

  const user = await req.db.prepare('SELECT id, email, password_hash, password_salt, name, role FROM users WHERE email = ?').get(email.toLowerCase().trim());

  const fakeHash = `pbkdf2$${pbkdf2Iterations(req.env)}$` + '0'.repeat(64);
  const storedHash = user?.password_hash || fakeHash;
  const storedSalt = user?.password_salt || '0'.repeat(32);
  const valid = await verifyPassword(password, storedSalt, storedHash);

  if (!user || !valid) {
    const { count, blockedUntil } = recordFail(ip);
    const payload = { error: 'invalid_credentials', message: 'Email o clave incorrectos' };
    if (blockedUntil) {
      const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
      res.setHeader('Retry-After', String(wait));
      payload.message = `Demasiados intentos. Espera ${wait}s.`;
      payload.error = 'too_many_attempts';
      payload.attempts = count;
      return res.status(429).json(payload);
    }
    payload.attempts = count;
    return res.status(401).json(payload);
  }

  clearFails(ip);
  const token = await signJwt({ sub: user.id, email: user.email, role: user.role }, req.env);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export default router;
