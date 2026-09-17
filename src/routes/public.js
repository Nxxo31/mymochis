import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

router.get('/', (req, res) => {
  const config = db.prepare('SELECT * FROM config WHERE id = 1').get();
  const flavors = db.prepare('SELECT id, name, description, price, available, image_url, color, sort_order FROM flavors WHERE available = 1 ORDER BY sort_order, name').all();
  const combos = db.prepare('SELECT id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order FROM combos WHERE available = 1 ORDER BY sort_order, id').all();
  const promos = db.prepare("SELECT * FROM promos WHERE active = 1 AND (starts_at IS NULL OR starts_at <= datetime('now')) AND (ends_at IS NULL OR ends_at >= datetime('now'))").all();
  res.json({ config, flavors, combos, promos });
});

export default router;