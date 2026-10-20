// Unidad de stock (auditoria 2026-10-20, bug #6):
//   available       -> booleano legacy: el combo aparece en el catalogo.
//   units_available -> contador de unidades del lote. -1 = ilimitado.
//   units_sold      -> unidades comprometidas por pedidos.
// Antes solo existia available (booleano): los combos se vendian infinitamente.
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();

const COLS = 'id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order, units_available, units_sold';

function shape(r) {
  return {
    ...r,
    available: !!r.available,
    featured: !!r.featured,
    stock_remaining: r.units_available < 0 ? null : Math.max(0, r.units_available),
    unlimited: r.units_available < 0,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${COLS} FROM combos ORDER BY sort_order, id`).all();
  res.json(rows.map(shape));
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const { name, units, price, description, compare_at_price, available, featured,
          image_url, sort_order, units_available } = req.body || {};
  if (!name || units == null || price == null) {
    return res.status(400).json({ error: 'bad_request', message: 'name, units, price son obligatorios' });
  }
  const stock = units_available == null ? -1 : Number(units_available);
  if (!Number.isInteger(stock) || stock < -1) {
    return res.status(400).json({ error: 'bad_request', message: 'units_available debe ser -1 (ilimitado) o un entero >= 0' });
  }
  const result = db.prepare(`
    INSERT INTO combos (name, units, price, description, compare_at_price, available,
                        featured, image_url, sort_order, units_available, units_sold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(name, units, price, description || null, compare_at_price || null,
         available ? 1 : 0, featured ? 1 : 0, image_url || null, sort_order || 0, stock);
  res.status(201).json(shape(db.prepare(`SELECT ${COLS} FROM combos WHERE id = ?`).get(result.lastInsertRowid)));
});

router.put('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT * FROM combos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'units', 'price', 'description', 'compare_at_price', 'available',
                   'featured', 'image_url', 'sort_order', 'units_available'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('available' in updates) updates.available = updates.available ? 1 : 0;
  if ('featured' in updates) updates.featured = updates.featured ? 1 : 0;
  if ('units_available' in updates) {
    const stock = Number(updates.units_available);
    if (!Number.isInteger(stock) || stock < -1) {
      return res.status(400).json({ error: 'bad_request', message: 'units_available debe ser -1 (ilimitado) o un entero >= 0' });
    }
    updates.units_available = stock;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE combos SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(shape(db.prepare(`SELECT ${COLS} FROM combos WHERE id = ?`).get(req.params.id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const result = db.prepare('DELETE FROM combos WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;

