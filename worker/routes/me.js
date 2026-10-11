import { Router } from '../router.js';
import { authMiddleware } from '../auth.js';

const router = new Router();

router.get('/', authMiddleware, async (req, res) => {
  const user = await req.db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user });
});

export default router;
