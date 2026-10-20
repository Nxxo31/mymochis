// Fix bug #10 (auditoría 2026-10-20): las descripciones de sabores quedaron con
// U+FFFD (�) en la DB — el emoji se corrompió en el seed. Se reescriben en
// texto plano ASCII-safe que renderiza igual en landing, tienda y panel.
//
// Idempotente: solo toca filas que contienen U+FFFD.

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/mymochis.db');

const GOOD = 'Lote semanal · hecho hoy en Neiva';
const BAD = /\uFFFD/;
const char65533 = String.fromCharCode(65533);

const flavors = db.prepare('SELECT id, description FROM flavors').all();
let fixed = 0;
for (const f of flavors) {
  if (BAD.test(f.description || '')) {
    db.prepare('UPDATE flavors SET description = ? WHERE id = ?').run(GOOD, f.id);
    fixed++;
    console.log(`  flavor ${f.id} → "${GOOD}"`);
  }
}

const combos = db.prepare('SELECT id, description FROM combos').all();
for (const c of combos) {
  if (BAD.test(c.description || '')) {
    db.prepare('UPDATE combos SET description = ? WHERE id = ?').run(GOOD, c.id);
    fixed++;
    console.log(`  combo ${c.id} → "${GOOD}"`);
  }
}

// Cualquier otra tabla con el mismo problema en columnas de texto.
// Se usa `instr(col, char(65533))` y NO `LIKE '%'||char(65533)||'%'`: el
// U+FFFD ocupa 3 bytes en UTF-8, y el LIKE con un char de 1 byte no matchea
// (auditoría 2026-10-20 — el primer sweep reportaba "PENDIENTE" y fixed=0).
const SWEEPS = [
  { table: 'flavors', col: 'description', value: GOOD },
  { table: 'combos', col: 'description', value: GOOD },
  { table: 'promos', col: 'name', value: '\u00A710% OFF · 10% en tu primer pedido!' },
  { table: 'config', col: 'tagline', value: GOOD },
  { table: 'config', col: 'description', value: GOOD },
];

for (const { table, col, value } of SWEEPS) {
  try {
    // Se usa la PK real de cada tabla, no `rowid`: en promos la consulta
    // `SELECT rowid ...` devolvió la columna `id` y el UPDATE escribía sobre
    // una fila inexistente (el try/catch silenciaba el fallo).
    const pk = db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.pk === 1)?.name;
    if (!pk) { console.log(`  (skip ${table}: sin PK)`); continue; }
    const rows = db.prepare(
      `SELECT ${pk} AS pk FROM ${table} WHERE instr(${col}, char(65533)) > 0`
    ).all();
    for (const r of rows) {
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pk} = ?`).run(value, r.pk);
      fixed++;
      console.log(`  ${table}.${col} ${pk}=${r.pk} → "${value}"`);
    }
  } catch (e) { console.log(`  (skip ${table}.${col}: ${e.message})`); }
}

// release_windows.notes: el U+FFFD reemplazaba el primer byte de un carácter
// acentuado (á→Ma�ana). Borrar el U+FFFD deja "Maana", no "Mañana": se
// reconstruye el texto correcto en vez de intentar adivinar la letra perdida.
const WINDOW_NOTES = {
  1: 'Mañana 3pm-7pm (recogida en cocina oculta)',
  2: 'Próxima semana · pedidos anticipados',
};
try {
  for (const [id, notes] of Object.entries(WINDOW_NOTES)) {
    const cur = db.prepare('SELECT notes FROM release_windows WHERE id = ?').get(Number(id));
    if (cur && (cur.notes == null || cur.notes.includes(char65533) || cur.notes !== notes)) {
      db.prepare('UPDATE release_windows SET notes = ? WHERE id = ?').run(notes, Number(id));
      fixed++;
      console.log(`  release_windows.notes id=${id} → ${JSON.stringify(notes)}`);
    }
  }
} catch (e) { console.log(`  (skip release_windows.notes: ${e.message})`); }

console.log(`\nfixed=${fixed}`);
