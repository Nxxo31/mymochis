import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = Router();

const VALID_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'whatsapp'];
const VALID_STATUS = ['draft', 'scheduled', 'posted', 'failed'];

router.get('/', authMiddleware, (req, res) => {
  const { platform, status } = req.query;
  const wheres = [];
  const params = [];
  if (platform) { wheres.push('platform = ?'); params.push(platform); }
  if (status) { wheres.push('status = ?'); params.push(status); }
  const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM social_posts ${whereSql} ORDER BY scheduled_for DESC, created_at DESC`).all(...params);
  res.json(rows);
});

router.post('/', authMiddleware, (req, res) => {
  const { platform, content, image_url, scheduled_for, notes, status } = req.body || {};
  if (!platform || !content) return res.status(400).json({ error: 'bad_request', message: 'platform, content son obligatorios' });
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: 'bad_request', message: `platform inválido. Valores: ${VALID_PLATFORMS.join(',')}` });
  if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'bad_request', message: `status inválido` });
  const result = db.prepare(
    'INSERT INTO social_posts (platform, content, image_url, scheduled_for, status, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(platform, content, image_url || null, scheduled_for || null, status || 'draft', notes || null);
  res.status(201).json(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', authMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const allowed = ['platform', 'content', 'image_url', 'scheduled_for', 'posted_at', 'status', 'notes'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('platform' in updates && !VALID_PLATFORMS.includes(updates.platform)) {
    return res.status(400).json({ error: 'bad_request', message: `platform inválido` });
  }
  if ('status' in updates && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: 'bad_request', message: `status inválido` });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });
  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE social_posts SET ${setSql} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(req.params.id));
});

router.delete('/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM social_posts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

export default router;