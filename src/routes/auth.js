import { Router } from 'express';
import { db } from '../db.js';
import { hashPassword, verifyPassword, signJwt } from '../auth.js';

const router = Router();

router.post('/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });
  if (password.length < 6) return res.status(400).json({ error: 'bad_request', message: 'password debe tener al menos 6 caracteres' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'email_taken', message: 'Ese email ya está registrado' });

  const { salt, hash } = hashPassword(password);
  const result = db.prepare(
    'INSERT INTO users (email, password_hash, password_salt, name) VALUES (?, ?, ?, ?)'
  ).run(email.toLowerCase(), hash, salt, name || null);

  const userId = result.lastInsertRowid;
  const token = signJwt({ sub: userId, email: email.toLowerCase(), role: 'admin' });
  res.status(201).json({ token, user: { id: userId, email: email.toLowerCase(), name: name || null, role: 'admin' } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'bad_request', message: 'email y password son obligatorios' });

  const user = db.prepare('SELECT id, email, password_hash, password_salt, name, role FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'invalid_credentials', message: 'Email o clave incorrectos' });
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Email o clave incorrectos' });
  }

  const token = signJwt({ sub: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export default router;