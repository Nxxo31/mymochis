// Unidad de stock (auditoria 2026-10-20, bug #6):
//   available       -> booleano legacy: el combo aparece en el catalogo.
//   units_available -> contador de unidades del lote. -1 = ilimitado.
//   units_sold      -> unidades comprometidas por pedidos.
// Antes solo existia available (booleano): los combos se vendian infinitamente.
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = Router();

const COLS = 'id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order, units_available, units_sold, units_reserved';

function shape(r) {
  return {
    ...r,
    available: !!r.available,
    featured: !!r.featured,
    // Saldo real = capacidad - reservado - vendido. Con el modelo de dos
    // contadores (available - sold) una reserva por un pedido sin pagar no
    // contaba como consumida y el panel ofrecaba stock que ya no habia.
    stock_remaining: r.units_available < 0
      ? null
      : Math.max(0, r.units_available - (r.units_sold || 0) - (r.units_reserved || 0)),
    units_reserved: r.units_reserved || 0,
    units_sold: r.units_sold || 0,
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

// === Composicion del combo (spec 60): un combo es una lista de productos con qty ===
router.get('/:id/items', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT id FROM combos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare(`
    SELECT ci.id, ci.combo_id, ci.flavor_id, ci.qty, ci.sort_order,
           f.name AS flavor_name, f.price AS flavor_price, f.image_url AS flavor_image_url,
           f.available AS flavor_available
    FROM combo_items ci
    JOIN flavors f ON f.id = ci.flavor_id
    WHERE ci.combo_id = ?
    ORDER BY ci.sort_order, ci.id
  `).all(req.params.id);
  res.json(rows);
});

router.post('/:id/items', [authMiddleware, requireRole('admin')], (req, res) => {
  const existing = db.prepare('SELECT id FROM combos WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { flavor_id, qty = 1, sort_order = 0 } = req.body || {};
  if (!flavor_id) return res.status(400).json({ error: 'bad_request', message: 'flavor_id es obligatorio' });
  const flavor = db.prepare('SELECT id FROM flavors WHERE id = ?').get(flavor_id);
  if (!flavor) return res.status(404).json({ error: 'not_found', message: 'producto no existe' });
  try {
    const result = db.prepare(
      'INSERT INTO combo_items (combo_id, flavor_id, qty, sort_order) VALUES (?, ?, ?, ?)'
    ).run(req.params.id, flavor_id, Number(qty) || 1, Number(sort_order) || 0);
    res.status(201).json(db.prepare(`
      SELECT ci.id, ci.combo_id, ci.flavor_id, ci.qty, ci.sort_order,
             f.name AS flavor_name, f.price AS flavor_price
      FROM combo_items ci JOIN flavors f ON f.id = ci.flavor_id
      WHERE ci.id = ?
    `).get(result.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate', message: 'el producto ya esta en este combo' });
    throw e;
  }
});

router.delete('/:id/items/:itemId', [authMiddleware, requireRole('admin')], (req, res) => {
  const result = db.prepare('DELETE FROM combo_items WHERE id = ? AND combo_id = ?').run(req.params.itemId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;

