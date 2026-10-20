INSERT OR IGNORE INTO combos (name, units, price, description, compare_at_price, featured, sort_order) VALUES
  ('Combo 4', 4, 28000, 'Ideal para probar varios sabores en una tarde.', 32000, 0, 0),
  ('Combo 6', 6, 39000, 'El favorito para compartir en familia o con amigos.', 48000, 1, 1),
  ('Caja sorpresa 12', 12, 75000, 'Una caja surtida con todos los sabores y nuestras pruebas nuevas.', 96000, 0, 2);
SELECT id, name, units, price FROM combos ORDER BY sort_order, id;
