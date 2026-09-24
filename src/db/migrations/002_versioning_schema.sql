-- Core versioning schema.
--
-- A matrix version is an immutable, content-addressed document once published.
-- Drafts live in the same table with status='draft' and version_no IS NULL.
-- Published rows form a chain of half-open effective windows:
--   [effective_at, superseded_at)  (superseded_at NULL == currently in force)
-- Overlapping windows are rejected by the publish transaction (see versioning service).
CREATE TABLE IF NOT EXISTS matrix_versions (
  id                  INTEGER PRIMARY KEY,
  version_no          INTEGER UNIQUE,                 -- assigned on publish
  status              TEXT NOT NULL DEFAULT 'draft'  -- draft | published
                        CHECK (status IN ('draft','published')),
  description         TEXT,
  matrix_content      TEXT NOT NULL,                  -- canonical JSON document
  matrix_hash         TEXT NOT NULL,                  -- sha256(canonical JSON)
  effective_at        TEXT,                           -- UTC ISO-8601, set on publish
  superseded_at       TEXT,                           -- UTC ISO-8601, set when next version publishes
  idempotency_key     TEXT,                           -- request key that published this version
  created_at          TEXT NOT NULL,
  published_at        TEXT
);

-- Effective windows must not start at the same instant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_matrix_versions_effective_at
  ON matrix_versions(effective_at)
  WHERE status = 'published';

CREATE UNIQUE INDEX IF NOT EXISTS ux_matrix_versions_idempotency_key
  ON matrix_versions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_matrix_versions_status_effective
  ON matrix_versions(status, effective_at);

-- Normalized rule rows, kept alongside the denormalized matrix_content so the
-- rule set is queryable without relying on the JSON blob.
CREATE TABLE IF NOT EXISTS matrix_rules (
  version_id   INTEGER NOT NULL REFERENCES matrix_versions(id),
  rule_index   INTEGER NOT NULL,
  resource     TEXT NOT NULL,
  job_type_a   TEXT NOT NULL,
  job_type_b   TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'mutex'
                 CHECK (mode IN ('mutex')),
  PRIMARY KEY (version_id, rule_index, job_type_a, job_type_b)
);

-- Append-only decisions. Every scheduling / start decision freezes the exact
-- matrix version it was judged against and the concrete conflict basis. Rows
-- are never UPDATEd or DELETEd (enforced by trigger below), so historical
-- conclusions in plans, receipts and audits cannot be retroactively rewritten.
CREATE TABLE IF NOT EXISTS plan_decisions (
  id                    INTEGER PRIMARY KEY,
  decision_kind         TEXT NOT NULL
                          CHECK (decision_kind IN ('scheduled','start_confirmed','conflict')),
  job_id                TEXT NOT NULL,
  job_type              TEXT NOT NULL,
  resource              TEXT NOT NULL,
  planned_start_at      TEXT NOT NULL,
  planned_end_at        TEXT NOT NULL,
  decided_at            TEXT NOT NULL,
  matrix_version_id     INTEGER NOT NULL REFERENCES matrix_versions(id),
  matrix_version_no     INTEGER NOT NULL,            -- denormalized, frozen
  matrix_hash           TEXT NOT NULL,                -- frozen
  matrix_snapshot       TEXT NOT NULL,                -- full canonical matrix JSON, frozen
  conflict_basis        TEXT NOT NULL,                -- JSON: [] or [{job_id, job_type, rule}]
  conflicting_job_id    TEXT,
  request_idempotency_key TEXT,
  client_request_id     TEXT,
  UNIQUE (client_request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_decisions_request_key
  ON plan_decisions(request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_plan_decisions_job ON plan_decisions(job_id);
CREATE INDEX IF NOT EXISTS ix_plan_decisions_resource_time
  ON plan_decisions(resource, planned_start_at);

-- Append-only audit trail for matrix lifecycle events.
CREATE TABLE IF NOT EXISTS audit_events (
  id            INTEGER PRIMARY KEY,
  event_type    TEXT NOT NULL,                        -- draft_created | draft_updated | published | publish_rejected | ...
  aggregate     TEXT NOT NULL,                        -- matrix_version | plan_decision
  aggregate_id  TEXT,
  payload       TEXT NOT NULL,                        -- JSON
  occurred_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_audit_events_aggregate ON audit_events(aggregate, aggregate_id);

-- ---- Immutability guards ----------------------------------------------------
-- Published matrix versions may only move published -> nothing (no UPDATE at
-- all is permitted, including effective window bookkeeping which happens via
-- the next row's insert; superseded_at updates are therefore allowed on a
-- whitelist).
CREATE TRIGGER IF NOT EXISTS trg_matrix_versions_immutable
BEFORE UPDATE ON matrix_versions
BEGIN
  SELECT CASE
    WHEN OLD.status = 'published'
         AND (
           NEW.version_no     IS NOT OLD.version_no
           OR NEW.matrix_content <> OLD.matrix_content
           OR NEW.matrix_hash    <> OLD.matrix_hash
           OR NEW.effective_at   <> OLD.effective_at
           OR NEW.status         <> OLD.status
         )
    THEN RAISE(ABORT, 'published matrix version is immutable')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_matrix_versions_no_delete
BEFORE DELETE ON matrix_versions
WHEN OLD.status = 'published'
BEGIN
  SELECT RAISE(ABORT, 'published matrix versions cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_matrix_rules_immutable
BEFORE UPDATE ON matrix_rules
WHEN EXISTS (SELECT 1 FROM matrix_versions v WHERE v.id = OLD.version_id AND v.status = 'published')
BEGIN
  SELECT RAISE(ABORT, 'rules of a published matrix version are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_decisions_no_update
BEFORE UPDATE ON plan_decisions
BEGIN
  SELECT RAISE(ABORT, 'plan decisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_decisions_no_delete
BEFORE DELETE ON plan_decisions
BEGIN
  SELECT RAISE(ABORT, 'plan decisions are append-only');
END;
