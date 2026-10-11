import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = new Router();

router.get('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const rows = await req.db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC LIMIT 200')
    .all();
  res.json({ users: rows });
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
