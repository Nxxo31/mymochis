import { Router } from '../router.js';
import { authMiddleware, requireRole, hashPassword } from '../auth.js';

const router = new Router();

router.get('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const rows = await req.db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC LIMIT 200')
    .all();
  res.json({ users: rows });
});

// Crear cuentas (multi-admin) — solo un admin puede crear otra.
router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const name = String(b.name || '').trim().slice(0, 120) || null;
  const role = b.role === 'admin' ? 'admin' : 'customer';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'bad_email', message: 'Email inválido' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'bad_password', message: 'Contraseña demasiado larga' });
  }
  const exists = await req.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(409).json({ error: 'email_taken', message: 'Ya existe una cuenta con ese email' });
  }

  const { salt, hash } = await hashPassword(password, req.env);
  const r = await req.db.prepare(
    'INSERT INTO users (email, password_hash, password_salt, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(email, hash, salt, name, role);
  res.status(201).json({ id: r.meta?.last_row_id ?? null, email, name, role });
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'bad_id', message: 'id invalido' });
  }
  if (id === req.user.sub) {
    return res.status(400).json({ error: 'self_delete', message: 'No podes eliminar tu propia cuenta admin' });
  }
  const target = await req.db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'admin') {
    return res.status(403).json({ error: 'cannot_delete_admin', message: 'No se puede eliminar otro admin desde este endpoint' });
  }
  await req.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true, deleted: { id: target.id, email: target.email } });
});

export default router;
