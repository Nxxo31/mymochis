// MyMochis demo seed — run once via: node scripts/seed-demo.mjs
// Writes flavors, combos, release_windows to the live DB.
// Safe to re-run: uses INSERT OR IGNORE patterns and idempotent UUIDs.

import { db, init } from '../src/db.js';
import { randomBytes } from 'node:crypto';

init();

const today = new Date();
const toISO = (d) => d.toISOString().slice(0, 10);
const shortId = () => randomBytes(8).toString('hex');

// 1) Categories
const cats = [
  ['Clásicos', 'clasicos', 1],
  ['Frutales', 'frutales', 2],
  ['Premium', 'premium', 3],
];
for (const [name, slug, sort] of cats) {
  db.prepare(`INSERT OR IGNORE INTO categories(name, slug, sort_order, active) VALUES(?,?,?,1)`).run(name, slug, sort);
}

const catIds = {};
for (const r of db.prepare('SELECT id, slug FROM categories').all()) catIds[r.slug] = r.id;

// 2) Flavors (id TEXT PRIMARY KEY — use short UUID)
const flavorData = [
  ['Fresas con crema',     'Fresa natural colada con crema pastelera artesanal.',                8000,  '#FFB8C8', 'frutales'],
  ['Chokis & cream',       'Cobertura de chocolate con crujiente de galleta y corazón cremoso.', 9000,  '#A78BD9', 'clasicos'],
  ['Blueberry cheesecake', 'Mochi con relleno de cheesecake de arándanos.',                      10000, '#C5B0E8', 'premium'],
  ['Durazno caramelizado', 'Trozos de durazno fresco con caramelo de panela.',                    8000,  '#FBD773', 'frutales'],
  ['Crema pastelera',      'Mochi clásico con crema pastelera de la casa.',                       7000,  '#FFE8A8', 'clasicos'],
];
const flavorIds = {};
for (const [name, desc, price, color, catSlug] of flavorData) {
  const existing = db.prepare('SELECT id FROM flavors WHERE name=?').get(name);
  if (existing) {
    flavorIds[name] = existing.id;
    db.prepare('UPDATE flavors SET price=?, description=?, color=?, available=1 WHERE id=?').run(price, desc, color, existing.id);
    continue;
  }
  const fid = shortId();
  db.prepare(`INSERT INTO flavors(id, name, description, price, color, available, category_id, sort_order) VALUES(?,?,?,?,?,1,?,50)`)
    .run(fid, name, desc, price, color, catIds[catSlug]);
  flavorIds[name] = fid;
}
console.log('flavors seeded:', Object.keys(flavorIds).length, Object.values(flavorIds));

// 3) Combos (id INTEGER AUTOINCREMENT — let SQLite assign)
const comboData = [
  ['Combo 4',           4,  28000, 32000, 'Cuatro mochis surtidos, ideal para probar.', 0],
  ['Combo 6',           6,  40000, 48000, 'Medio kilo de mochis variados.',            1],
  ['Caja sorpresa 12',  12, 75000, 96000, 'Docena seleccionada por el chef, opción sorpresa.', 0],
];
const comboIds = {};
for (const [name, units, price, cap, desc, featured] of comboData) {
  const existing = db.prepare('SELECT id FROM combos WHERE name=?').get(name);
  if (existing) {
    db.prepare('UPDATE combos SET units=?, price=?, compare_at_price=?, description=?, available=1, featured=? WHERE id=?')
      .run(units, price, cap, desc, featured, existing.id);
    comboIds[name] = existing.id;
    continue;
  }
  db.prepare(`INSERT INTO combos(name, units, price, compare_at_price, description, available, featured, sort_order) VALUES(?,?,?,?,?,1,?,50)`)
    .run(name, units, price, cap, desc, featured);
  comboIds[name] = db.prepare('SELECT id FROM combos WHERE name=?').get(name).id;
}
console.log('combos seeded:', db.prepare('SELECT COUNT(*) AS n FROM combos').get().n);

// 4) release_windows for next 7 days, all open
const upDays = [];
for (let n = 1; n <= 7; n++) {
  const d = new Date(today.getTime() + n * 86400000);
  upDays.push(toISO(d));
}
let newWindows = 0;
for (const iso of upDays) {
  const existing = db.prepare('SELECT id FROM release_windows WHERE release_date=?').get(iso);
  let wid = existing?.id;
  if (!wid) {
    const cutoff = iso + ' 08:00:00';
    db.prepare(`INSERT INTO release_windows(release_date, cutoff_at, status, notes) VALUES(?,?, 'open', 'Demo week')`).run(iso, cutoff);
    wid = db.prepare('SELECT id FROM release_windows WHERE release_date=?').get(iso).id;
    newWindows++;
  } else {
    db.prepare(`UPDATE release_windows SET status='open' WHERE id=?`).run(wid);
  }
  // Link all flavors, 30 units each
  for (const fid of Object.values(flavorIds)) {
    db.prepare(`INSERT OR IGNORE INTO release_items(window_id, flavor_id, units_available, units_sold) VALUES(?,?,30,0)`)
      .run(wid, fid);
  }
}
console.log('release_windows this run:', newWindows, 'total:', db.prepare('SELECT COUNT(*) AS n FROM release_windows').get().n);
console.log('release_items:', db.prepare('SELECT COUNT(*) AS n FROM release_items').get().n);
console.log('✓ seed committed via node:sqlite (same driver as server)');
