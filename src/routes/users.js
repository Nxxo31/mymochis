import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { db } from '../db.js';

const router = Router();

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const rows = db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC LIMIT 200')
    .all();
  res.json({ users: rows });
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