import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

// Números que reciben pedidos (multi-admin / multi-número) — espejo de src/routes/recipients.js

const router = new Router();

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

router.get('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const rows = await req.db.prepare('SELECT * FROM order_recipients ORDER BY active DESC, sort_order ASC, id ASC').all();
  res.json({ recipients: rows.map(r => ({ ...r, phone_display: r.phone ? `+${r.phone}` : '' })) });
});

router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim().slice(0, 60);
  const phone = normalizePhone(b.phone);
  const sort_order = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0;

  if (!label) return res.status(400).json({ error: 'bad_label', message: 'El nombre del destinatario es obligatorio' });
  if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'bad_phone', message: 'Número inválido: formato internacional sin espacios (ej: 573001234567)' });

  const exists = await req.db.prepare('SELECT id FROM order_recipients WHERE phone = ?').get(phone);
  if (exists) return res.status(409).json({ error: 'duplicate', message: 'Ese número ya está en la lista de destinatarios' });

  const r = await req.db.prepare('INSERT INTO order_recipients (label, phone, active, sort_order) VALUES (?, ?, 1, ?)').run(label, phone, sort_order);
  const newId = r.meta?.last_row_id ?? r.lastInsertRowid;
  const row = await req.db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(newId);
  res.status(201).json(row);
});

router.patch('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id', message: 'id inválido' });
  const row = await req.db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found', message: 'Destinatario no encontrado' });

  const b = req.body || {};
  const updates = {};
  if ('label' in b) {
    const label = String(b.label || '').trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: 'bad_label', message: 'El nombre no puede quedar vacío' });
    updates.label = label;
  }
  if ('phone' in b) {
    const phone = normalizePhone(b.phone);
    if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'bad_phone', message: 'Número inválido' });
    const dup = await req.db.prepare('SELECT id FROM order_recipients WHERE phone = ? AND id != ?').get(phone, id);
    if (dup) return res.status(409).json({ error: 'duplicate', message: 'Ese número ya está en la lista' });
    updates.phone = phone;
  }
  if ('active' in b) updates.active = b.active ? 1 : 0;
  if ('sort_order' in b && Number.isFinite(Number(b.sort_order))) updates.sort_order = Number(b.sort_order);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields', message: 'Nada que actualizar' });

  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await req.db.prepare(`UPDATE order_recipients SET ${setSql} WHERE id = ?`).run(...Object.values(updates), id);
  res.json(await req.db.prepare('SELECT * FROM order_recipients WHERE id = ?').get(id));
});

router.delete('/:id', [authMiddleware, requireRole('admin')], async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_id', message: 'id inválido' });
  const r = await req.db.prepare('DELETE FROM order_recipients WHERE id = ?').run(id);
  if ((r.meta?.changes ?? r.changes ?? 1) === 0) return res.status(404).json({ error: 'not_found', message: 'Destinatario no encontrado' });
  res.json({ ok: true });
});

export default router;
