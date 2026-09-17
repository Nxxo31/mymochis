import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.get('/', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user });
});

export default router;