-- Migration ledger. Applied transactionally and recorded in
-- `migrations`; every subsequent structural change is a new migration.
CREATE TABLE IF NOT EXISTS migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL
);
