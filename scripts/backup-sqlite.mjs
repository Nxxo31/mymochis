import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node backup-sqlite.mjs <source.db> <target.db>');
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });

const quotedTarget = `'${String(target).replaceAll("'", "''")}'`;
const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`VACUUM INTO ${quotedTarget}`);
} finally {
  db.close();
}
