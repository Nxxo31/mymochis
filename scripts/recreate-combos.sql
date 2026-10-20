-- Step 1: dedupe existing combos (keep lowest id)
DELETE FROM combos WHERE id NOT IN (SELECT MIN(id) FROM combos GROUP BY name, units);
-- Step 2: recreate table with UNIQUE constraint
CREATE TABLE combos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  units INTEGER NOT NULL,
  price INTEGER NOT NULL,
  description TEXT,
  compare_at_price INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, units)
);
INSERT INTO combos_new (id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order, created_at)
SELECT id, name, units, price, description, compare_at_price, available, featured, image_url, sort_order, created_at FROM combos;
DROP TABLE combos;
ALTER TABLE combos_new RENAME TO combos;
SELECT 'final' as status, COUNT(*) as c FROM combos;
SELECT id, name, units, price, sort_order FROM combos ORDER BY sort_order, id;
