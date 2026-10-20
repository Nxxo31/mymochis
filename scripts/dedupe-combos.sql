DELETE FROM combos WHERE id NOT IN (SELECT MIN(id) FROM combos GROUP BY name, units);
SELECT 'remaining' as label, COUNT(*) as c FROM combos;
SELECT id, name, units, price FROM combos ORDER BY id;
