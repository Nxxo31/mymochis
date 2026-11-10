// MyMochis · Export de reportes (spec 59, d4)
// GET /api/reports/export?kind=sales&from=YYYY-MM-DD&to=YYYY-MM-DD
// Devuelve CSV (abre en Excel) de pedidos del rango. Admin only.
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();

function esc(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/export', [authMiddleware, requireRole('admin')], (req, res) => {
  const { kind, from, to } = req.query;
  if (kind !== 'sales') {
    return res.status(400).json({ error: 'bad_request', message: "kind debe ser 'sales'" });
  }
  const cond = [];
  const params = [];
  if (from) { cond.push('date(o.created_at) >= date(?)'); params.push(from); }
  if (to) { cond.push('date(o.created_at) <= date(?)'); params.push(to); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.pickup_day,
           o.total, o.status, o.payment_status, o.delivery_mode, c.name AS courier
    FROM orders o
    LEFT JOIN couriers c ON c.id = o.courier_id
    ${where}
    ORDER BY o.created_at
  `).all(...params);

  const lines = [
    ['id', 'created_at', 'customer_name', 'customer_phone', 'pickup_day', 'total', 'status', 'payment_status', 'delivery_mode', 'courier'].join(','),
    ...rows.map(r => [
      r.id, r.created_at, esc(r.customer_name), esc(r.customer_phone), r.pickup_day,
      r.total, r.status, r.payment_status, r.delivery_mode, esc(r.courier || ''),
    ].join(',')),
  ].join('\n') + '\n';

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=mymochis-ventas-${from || 'ini'}-a-${to || 'fin'}.csv`);
  res.send(lines);
});

export default router;
