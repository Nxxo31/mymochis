import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const VALID_DAYS = [0, 1, 2, 3, 4, 5, 6];
const VALID_MODES = ['pickup', 'delivery', 'both'];

function validate(body) {
  const { day_of_week, start_time, end_time, mode, cutoff_offset_hours, active, sort_order, notes } = body || {};
  if (!VALID_DAYS.includes(Number(day_of_week))) return 'day_of_week debe ser 0..6';
  if (!/^\d{2}:\d{2}$/.test(start_time || '')) return 'start_time debe ser HH:MM';
  if (!/^\d{2}:\d{2}$/.test(end_time || '')) return 'end_time debe ser HH:MM';
  if (!VALID_MODES.includes(mode)) return `mode debe ser uno de: ${VALID_MODES.join(',')}`;
  if (cutoff_offset_hours != null && (Number(cutoff_offset_hours) < 0 || Number(cutoff_offset_hours) > 168)) return 'cutoff_offset_hours debe ser 0..168';
  return null;
}

router.get('/', (req, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user;
  const sql = includeInactive
    ? 'SELECT * FROM delivery_schedule ORDER BY day_of_week, sort_order, start_time'
    : 'SELECT * FROM delivery_schedule WHERE active = 1 ORDER BY day_of_week, sort_order, start_time';
  const rows = db.prepare(sql).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM delivery_schedule WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', authMiddleware, (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: 'bad_request', message: err });
  const { day_of_week, start_time, end_time, mode, cutoff_offset_hours = 8, active = 1, sort_order = 0, notes = null } = req.body;
  const info = db.prepare(`
    INSERT INTO delivery_schedule (day_of_week, start_time, end_time, mode, cutoff_offset_hours, active, sort_order, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(day_of_week, start_time, end_time, mode, cutoff_offset_hours, active ? 1 : 0, sort_order, notes);
  res.status(201).json(db.prepare('SELECT * FROM delivery_schedule WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT id FROM delivery_schedule WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['day_of_week', 'start_time', 'end_time', 'mode', 'cutoff_offset_hours', 'active', 'sort_order', 'notes'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('active' in updates) updates.active = updates.active ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const err = validate({ ...db.prepare('SELECT * FROM delivery_schedule WHERE id = ?').get(req.params.id), ...updates });
  if (err) return res.status(400).json({ error: 'bad_request', message: err });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE delivery_schedule SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM delivery_schedule WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM delivery_schedule WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;