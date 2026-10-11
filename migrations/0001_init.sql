-- MyMochis D1 init — referencia. El worker aplica worker/db.js SCHEMA_SQL + SEED_SQL
-- idempotente en cold-start, asi que estas migraciones son opcionales/documentales.
-- Para aplicar manual: wrangler d1 execute mymochis --file=migrations/0001_init.sql
-- (El contenido canonico del schema vive en worker/db.js SCHEMA_SQL para mantener
--  una sola fuente; este archivo se genera para trazabilidad de despliegue.)

SELECT 'Schema managed by worker/db.js ensureInit() (idempotent)' AS note;
