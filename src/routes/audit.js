// MyMochis · Auditoria de acciones del admin (spec 58, p10)
// GET /api/audit?limit=&action= -> la bitacora de quien hizo que.
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth.js';
import { listAudit } from '../lib/audit.js';

const router = Router();

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  res.json({ entries: listAudit({ limit: req.query.limit, action: req.query.action || null }) });
});

export default router;
