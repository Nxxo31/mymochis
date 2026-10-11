import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = new Router();

router.get('/', async (req, res) => {
  const row = await req.db.prepare('SELECT * FROM config WHERE id = 1').get();
  res.json(row);
});

router.put('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const allowed = [
    'business_name', 'tagline', 'description',
    'whatsapp_number', 'instagram_handle', 'instagram_url',
    'facebook_url', 'tiktok_handle',
    'pickup_address', 'pickup_schedule',
    'hero_image_url'
  ];
  const updates = {};
  for (const k of allowed) if (k in (req.body || {})) updates[k] = req.body[k];
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_fields' });

  const setSql = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  await req.db.prepare(`UPDATE config SET ${setSql}, updated_at = datetime('now') WHERE id = 1`).run(...values);
  const row = await req.db.prepare('SELECT * FROM config WHERE id = 1').get();
  res.json(row);
});

export default router;
