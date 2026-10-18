import { Router } from 'express';
import { authMiddleware, requireRole, hashPassword } from '../auth.js';
import { db } from '../db.js';

const router = Router();

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const rows = db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC LIMIT 200')
    .all();
  res.json({ users: rows });
});

// Crear cuentas (multi-admin) — solo un admin puede crear otra.
// role se blinda: 'admin' explícito o 'customer' para cualquier otro valor.
router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim().slice(0, 120) || null;
  const role = req.body?.role === 'admin' ? 'admin' : 'customer';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'Email inválido' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'bad_password', message: 'Contraseña demasiado larga' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(409).json({ error: 'email_taken', message: 'Ya existe una cuenta con ese email' });
  }

  const { salt, hash } = hashPassword(password);
  const r = db.prepare(
    'INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(email, hash, salt, name, role);
  res.status(201).json({ id: Number(r.lastInsertRowid), email, name, role });
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'bad_id', message: 'id inválido' });
  }
  if (id === req.user.sub) {
    return res.status(400).json({ error: 'self_delete', message: 'No podés eliminar tu propia cuenta admin' });
  }
  const target = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'admin') {
    return res.status(403).json({ error: 'cannot_delete_admin', message: 'No se puede eliminar otro admin desde este endpoint' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true, deleted: { id: target.id, email: target.email } });
});

export default router;