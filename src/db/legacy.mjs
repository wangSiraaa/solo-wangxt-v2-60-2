/**
 * Legacy (pre-versioning) mutex matrix support.
 *
 * The old system stored the mutex matrix as a flat pair table
 * `legacy_mutex_matrix` and plans as `legacy_job_plans` with no version
 * information. Migration 003 safely freezes that data as matrix version 1:
 *
 *   - every existing rule set becomes published version 1, effective at the
 *     epoch (1970-01-01), so ALL historical moments resolve to v1;
 *   - every existing plan is replayed against v1 and stored as an append-only
 *     decision row carrying the full v1 snapshot, exactly like new decisions;
 *   - if no legacy data exists, the built-in baseline matrix is published as
 *     v1 instead.
 *
 * The migration is idempotent: it never runs if a published version exists.
 */
import { canonicalize, matrixHash, normalizeMatrix, buildConflictIndex, findConflictRule } from '../domain/matrix.mjs';

export const LEGACY_MATRIX = Object.freeze({
  schema_version: 1,
  rules: [
    { resource: 'crane-a', job_types: ['lift', 'paint'], mode: 'mutex' },
    { resource: 'oven-1', job_types: ['cure', 'weld'], mode: 'mutex' },
    { resource: '*', job_types: ['weld', 'paint'], mode: 'mutex' },
  ],
});

export const EPOCH = '1970-01-01T00:00:00.000Z';

export function hasLegacyTables(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sqlite_master
       WHERE type='table' AND name IN ('legacy_mutex_matrix','legacy_job_plans')`,
    )
    .get();
  return row.c > 0;
}

/** DDL of the legacy schema, used by integration tests to simulate an old DB. */
export const LEGACY_DDL = `
CREATE TABLE legacy_mutex_matrix (
  resource    TEXT NOT NULL,
  job_type_a  TEXT NOT NULL,
  job_type_b  TEXT NOT NULL,
  PRIMARY KEY (resource, job_type_a, job_type_b)
);
CREATE TABLE legacy_job_plans (
  id                TEXT PRIMARY KEY,
  job_type          TEXT NOT NULL,
  resource          TEXT NOT NULL,
  planned_start_at  TEXT NOT NULL,
  planned_end_at    TEXT NOT NULL,
  status            TEXT NOT NULL,
  conflict_note     TEXT
);
`;

function matrixFromLegacyPairs(pairs) {
  const groups = new Map();
  for (const p of pairs) {
    if (!groups.has(p.resource)) groups.set(p.resource, new Set());
    groups.get(p.resource).add(p.job_type_a);
    groups.get(p.resource).add(p.job_type_b);
  }
  return {
    schema_version: 1,
    rules: [...groups.entries()].map(([resource, types]) => ({
      resource,
      job_types: [...types],
      mode: 'mutex',
    })),
  };
}

const insertVersion = (db) =>
  db.prepare(
    `INSERT INTO matrix_versions
       (version_no, status, description, matrix_content, matrix_hash,
        effective_at, superseded_at, created_at, published_at)
     VALUES (1, 'published', ?, ?, ?, ?, NULL, ?, ?)`,
  );

const insertRule = (db) =>
  db.prepare(
    `INSERT INTO matrix_rules (version_id, rule_index, resource, job_type_a, job_type_b, mode)
     VALUES (@version_id, @rule_index, @resource, @job_type_a, @job_type_b, 'mutex')`,
  );

const insertDecision = (db) =>
  db.prepare(
    `INSERT INTO plan_decisions
       (decision_kind, job_id, job_type, resource, planned_start_at, planned_end_at, decided_at,
        matrix_version_id, matrix_version_no, matrix_hash, matrix_snapshot,
        conflict_basis, conflicting_job_id, client_request_id)
     VALUES (@decision_kind, @job_id, @job_type, @resource, @planned_start_at, @planned_end_at, @decided_at,
             1, 1, @matrix_hash, @matrix_snapshot,
             @conflict_basis, @conflicting_job_id, @client_request_id)`,
  );

/**
 * Evaluate one candidate against already-imported decisions, using the exact
 * same engine as live planning, so imported decisions replay identically.
 */
function evaluate(prior, candidate, index) {
  const basis = [];
  let conflictingJobId = null;
  for (const other of prior) {
    if (other.resource !== candidate.resource) continue;
    if (
      intervalsOverlap(
        candidate.planned_start_at,
        candidate.planned_end_at,
        other.planned_start_at,
        other.planned_end_at,
      ) === false
    ) {
      continue;
    }
    const rule = findConflictRule(
      index,
      candidate.resource,
      candidate.job_type,
      other.job_type,
    );
    if (rule) {
      basis.push({ job_id: other.job_id, job_type: other.job_type, rule });
      if (!conflictingJobId) conflictingJobId = other.job_id;
    }
  }
  return { basis, conflictingJobId };
}

function intervalsOverlap(startA, endA, startB, endB) {
  return Date.parse(startA) < Date.parse(endB) && Date.parse(startB) < Date.parse(endA);
}

export function seedLegacyV1(db) {
  const published = db
    .prepare(`SELECT COUNT(*) AS c FROM matrix_versions WHERE status = 'published'`)
    .get();
  if (published.c > 0) return;

  let content;
  let description;
  let importedPlans = [];

  if (hasLegacyTables(db)) {
    const pairs = db
      .prepare(
        `SELECT resource, job_type_a, job_type_b FROM legacy_mutex_matrix`,
      )
      .all();
    if (pairs.length > 0) {
      content = normalizeMatrix(matrixFromLegacyPairs(pairs));
      description = 'Imported from legacy_mutex_matrix (v1)';
    } else {
      content = normalizeMatrix(LEGACY_MATRIX);
      description = 'Baseline matrix (v1, empty legacy matrix)';
    }
    importedPlans = db
      .prepare(
        `SELECT id, job_type, resource, planned_start_at, planned_end_at, status, conflict_note
         FROM legacy_job_plans ORDER BY planned_start_at, id`,
      )
      .all();
  } else {
    content = normalizeMatrix(LEGACY_MATRIX);
    description = 'Baseline matrix (v1)';
  }

  const canonical = canonicalize(content);
  const hash = matrixHash(content);
  insertVersion(db).run(
    description,
    canonical,
    hash,
    EPOCH,
    EPOCH,
    EPOCH,
  );
  const versionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  content.rules.forEach((rule, ruleIndex) => {
    for (let i = 0; i < rule.job_types.length; i += 1) {
      for (let j = i + 1; j < rule.job_types.length; j += 1) {
        insertRule(db).run({
          version_id: versionId,
          rule_index: ruleIndex,
          resource: rule.resource,
          job_type_a: rule.job_types[i],
          job_type_b: rule.job_types[j],
        });
      }
    }
  });

  // Replay legacy plans against v1 in chronological order and freeze results.
  // A plan recorded as 'started' is an accepted receipt: whatever the current
  // rules say, history must preserve it, so its recorded kind wins and it
  // occupies its window for subsequent replay.
  const index = buildConflictIndex(content);
  const prior = [];
  for (const plan of importedPlans) {
    const { basis, conflictingJobId } = evaluate(prior, plan, index);
    const wasAcceptedReceipt = plan.status === 'started';
    const kind = wasAcceptedReceipt
      ? 'start_confirmed'
      : basis.length > 0
        ? 'conflict'
        : 'scheduled';
    const effectiveBasis = wasAcceptedReceipt ? [] : basis;
    const effectiveConflictingJobId = wasAcceptedReceipt ? null : conflictingJobId;
    insertDecision(db).run({
      decision_kind: kind,
      job_id: plan.id,
      job_type: plan.job_type,
      resource: plan.resource,
      planned_start_at: new Date(plan.planned_start_at).toISOString(),
      planned_end_at: new Date(plan.planned_end_at).toISOString(),
      decided_at: new Date(plan.planned_start_at).toISOString(),
      matrix_hash: hash,
      matrix_snapshot: canonical,
      conflict_basis: JSON.stringify(effectiveBasis),
      conflicting_job_id: effectiveConflictingJobId,
      client_request_id: `legacy:${plan.id}`,
    });
    prior.push({
      job_id: plan.id,
      job_type: plan.job_type,
      resource: plan.resource,
      planned_start_at: new Date(plan.planned_start_at).toISOString(),
      planned_end_at: new Date(plan.planned_end_at).toISOString(),
    });
  }

  db.prepare(
    `INSERT INTO audit_events (event_type, aggregate, aggregate_id, payload, occurred_at)
     VALUES ('v1_bootstrapped', 'matrix_version', '1', ?, ?)`,
  ).run(
    JSON.stringify({
      description,
      rule_count: content.rules.length,
      imported_plan_count: importedPlans.length,
      source: hasLegacyTables(db) ? 'legacy' : 'baseline',
    }),
    EPOCH,
  );
}
