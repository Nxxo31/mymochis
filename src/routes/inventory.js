// MyMochis · Inventario vendible (spec 59, d2)
// GET /api/inventory?date=YYYY-MM-DD  (admin)
// Stock vendible por sabor y combo por dia: disponible, reservado, vendido y
// producible (disponible - reservado - vendido).
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';
import { businessDate } from '../lib/business-time.js';

const router = Router();

function produce(available, reserved, sold) {
  if (available < 0) return null; // stock ilimitado
  return Math.max(0, available - reserved - sold);
}

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
    ? String(req.query.date)
    : businessDate();

  const windows = db.prepare(
    'SELECT id FROM release_windows WHERE release_date = ? AND status = ?'
  ).all(date, 'open');

  const rows = [];

  // Sabores: su stock vive en release_items por ventana de lanzamiento.
  const flavors = db.prepare(
    'SELECT id, name, price, color FROM flavors WHERE available = 1 ORDER BY sort_order, name'
  ).all();
  for (const f of flavors) {
    let available = 0;
    let reserved = 0;
    let sold = 0;
    for (const w of windows) {
      const item = db.prepare(
        'SELECT units_available, units_reserved, units_sold FROM release_items WHERE window_id = ? AND flavor_id = ?'
      ).get(w.id, f.id);
      if (item) {
        available += Number(item.units_available || 0);
        reserved += Number(item.units_reserved || 0);
        sold += Number(item.units_sold || 0);
      }
    }
    rows.push({
      kind: 'product',
      id: f.id,
      name: f.name,
      price: Number(f.price || 0),
      date,
      available,
      reserved,
      sold,
      producible: produce(available, reserved, sold),
    });
  }

  // Combos: su stock vive en la propia tabla combos.
  const combos = db.prepare(
    'SELECT id, name, price, units_available, units_reserved, units_sold FROM combos WHERE available = 1 ORDER BY sort_order, name'
  ).all();
  for (const c of combos) {
    const available = Number(c.units_available || 0);
    const reserved = Number(c.units_reserved || 0);
    const sold = Number(c.units_sold || 0);
    rows.push({
      kind: 'combo',
      id: c.id,
      name: c.name,
      price: Number(c.price || 0),
      date,
      available,
      reserved,
      sold,
      producible: produce(available, reserved, sold),
    });
  }

  res.json({ date, items: rows });
});

export default router;
