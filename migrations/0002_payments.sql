-- ============================================================================
-- MyMochis 0002_payments.sql — Spec §22.5 (DB schema)
-- Estado: APPEND-ONLY; las tablas usan CREATE TABLE IF NOT EXISTS
-- ============================================================================

-- 1. payments (la "operación" lógica: pagar pedido X por Y pesos)
CREATE TABLE IF NOT EXISTS payments (
  payment_id        TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL DEFAULT 'mymochis',
  order_id          TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'COP',
  state             TEXT NOT NULL DEFAULT 'INITIATED'
                       CHECK(state IN ('INITIATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_ACTION','UNRESOLVED','EXPIRED')),
  state_version     INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  customer_phone    TEXT,
  customer_email    TEXT,
  description       TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at        TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state, created_at);

-- 2. idempotency_records (UNIQUE por merchant+operation+key)
CREATE TABLE IF NOT EXISTS idempotency_records (
  merchant_id         TEXT NOT NULL,
  operation           TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  payment_id          TEXT,
  response_status     INTEGER,
  response_body_json  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  PRIMARY KEY (merchant_id, operation, idempotency_key)
);

-- 3. payment_attempts (cada interacción con un provider)
CREATE TABLE IF NOT EXISTS payment_attempts (
  attempt_id            TEXT PRIMARY KEY,
  payment_id            TEXT NOT NULL,
  provider              TEXT NOT NULL,
  provider_idempotency_key TEXT NOT NULL,
  provider_reference     TEXT,
  attempt_state          TEXT NOT NULL
                            CHECK(attempt_state IN ('INITIATED','PROCESSING','SUCCEEDED','FAILED','REQUIRES_ACTION','UNRESOLVED','EXPIRED')),
  provider_response_json TEXT,
  error_code             TEXT,
  error_message          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempts_payment ON payment_attempts(payment_id);
CREATE INDEX IF NOT EXISTS idx_attempts_provider_ref ON payment_attempts(provider, provider_reference);

-- 4. provider_events (durable inbox para webhooks)
CREATE TABLE IF NOT EXISTS provider_events (
  event_id            TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  provider_event_id   TEXT,
  payload_json        TEXT NOT NULL,
  signature           TEXT,
  received_at         TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at        TEXT,
  process_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK(process_status IN ('pending','processed','failed','quarantined')),
  process_attempts    INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_pending ON provider_events(process_status, received_at);

-- 5. ledger_entries (double-entry journal, append-only)
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id        TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL,
  account         TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'COP',
  memo            TEXT,
  posted_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_id) REFERENCES payments(payment_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_ledger_payment ON ledger_entries(payment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account, posted_at);

CREATE VIEW IF NOT EXISTS ledger_balances AS
SELECT account, currency, SUM(amount_minor) AS balance_minor
FROM ledger_entries
GROUP BY account, currency;

-- 6. outbox_events (transactional outbox)
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id        TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  published_at    TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(published_at, created_at);

-- 7. reconciliation_runs
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at       TEXT,
  provider          TEXT,
  status            TEXT NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','ok','mismatch','failed')),
  checks_total      INTEGER NOT NULL DEFAULT 0,
  mismatches        INTEGER NOT NULL DEFAULT 0,
  details_json      TEXT
);

-- 8. payment_methods (extender con provider + enabled)
-- ALTER handled in db.js init() via ensureColumn()

-- 9. orders (extender con payment_id y payment_state)
-- ALTER handled in db.js init() via ensureColumn()
