import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, requireRole } from '../auth.js';

// Números que reciben los pedidos (multi-admin / multi-número).
// El POST /api/orders hace round-robin entre los activos para el deep-link
// y (si hay Meta Cloud API configurada) broadcast a todos.

const router = Router();

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function rowOut(r) {
  return { ...r, phone_display: r.phone ? `+${r.phone}` : '' };
}

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const rows = db.prepare('SELECT * FROM order_recipients ORDER BY active DESC, sort_order ASC, id ASC').all();
  res.json({ recipients: rows.map(rowOut) });
});

router.post('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const label = String(req.body.label || '').trim().slice(0, 60);
  const phone = normalizePhone(req.body.phone);
  const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;

  if (!label) {
    return res.status(400).json({ error: 'bad_label', message: 'El nombre del destinatario es obligatorio' });
  }
  if (!/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({ error: 'bad_phone', message: 'Número inválido: formato internacional sin espacios (ej: 573001234567)' });
  }
  const exists = db.prepare('SELECT id FROM order_recipients WHERE phone = ?').get(phone);
  if (exists) {
    return res.status(409).json({ error: 'duplicate', message: 'Ese número ya está en la lista de destinatarios' });
  }
  const r = db.prepare('INSERT INTO order_recipients (label, phone, active, sort_order) VALUES (?, ?, 1, ?)').run(label, phone, sort_order);
  res.status(201).json(rowOut(db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(r.lastInsertRowid)));
});

router.patch('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id', message: 'id inválido' });
  const row = db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Destinatario no encontrado' });

  const updates = {};
  if ('label' in req.body) {
    const label = String(req.body.label || '').trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: 'bad_label', message: 'El nombre no puede quedar vacío' });
    updates.label = label;
  }
  if ('phone' in req.body) {
    const phone = normalizePhone(req.body.phone);
    if (!/^\d{8,15}$/.test(phone)) {
      return res.status(400).json({ error: 'bad_phone', message: 'Número inválido: formato internacional sin espacios' });
    }
    const dup = db.prepare('SELECT id FROM order_recipients WHERE phone = ? AND id != ?').get(phone, id);
    if (dup) return res.status(409).json({ error: 'duplicate', message: 'Ese número ya está en la lista' });
    updates.phone = phone;
  }
  if ('active' in req.body) updates.active = req.body.active ? 1 : 0;
  if ('sort_order' in req.body && Number.isFinite(Number(req.body.sort_order))) {
    updates.sort_order = Number(req.body.sort_order);
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_fields', message: 'Nada que actualizar' });
  }

  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE order_recipients SET ${setSql} WHERE id = ?`).run(...Object.values(updates), id);
  res.json(rowOut(db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(id)));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id', message: 'id inválido' });
  const r = db.prepare('DELETE FROM order_recipients WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'not_found', message: 'Destinatario no encontrado' });
  res.json({ ok: true });
});

export default router;
