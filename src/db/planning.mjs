/**
 * Planning service.
 *
 * Every scheduling / start decision:
 *   1. resolves the matrix version in force for planned_start_at at decision
 *      time (this is the "cross effective boundary" selection),
 *   2. evaluates the conflict against prior decisions using ONLY that frozen
 *      version's rules,
 *   3. appends an immutable decision row carrying the full matrix snapshot,
 *      its hash, and the explicit conflict basis (rule + offending job).
 *
 * Later matrix publications never touch these rows: old plans keep replaying
 * under the version they were judged by.
 */
import { buildConflictIndex, findConflictRule, matrixHash } from '../domain/matrix.mjs';
import { toIso } from '../domain/clock.mjs';
import { withWriteTransaction } from './index.mjs';

export class PlanningError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const DEFAULT_DURATION_MINUTES = 60;

function intervalsOverlap(startA, endA, startB, endB) {
  return Date.parse(startA) < Date.parse(endB) && Date.parse(startB) < Date.parse(endA);
}

function hydrateDecision(row) {
  return {
    id: row.id,
    decision_kind: row.decision_kind,
    job_id: row.job_id,
    job_type: row.job_type,
    resource: row.resource,
    planned_start_at: row.planned_start_at,
    planned_end_at: row.planned_end_at,
    decided_at: row.decided_at,
    matrix_version_id: row.matrix_version_id,
    matrix_version_no: row.matrix_version_no,
    matrix_hash: row.matrix_hash,
    matrix_snapshot: JSON.parse(row.matrix_snapshot),
    conflict_basis: JSON.parse(row.conflict_basis),
    conflicting_job_id: row.conflicting_job_id,
    request_idempotency_key: row.request_idempotency_key,
  };
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function audit(db, eventType, aggregateId, payload, at) {
  db.prepare(
    `INSERT INTO audit_events (event_type, aggregate, aggregate_id, payload, occurred_at)
     VALUES (?, 'plan_decision', ?, ?, ?)`,
  ).run(eventType, String(aggregateId), JSON.stringify(payload), at);
}

export function createPlanningService(db, versioning, clock) {
  /**
   * Submit / start a job plan. A conflicting plan is still recorded
   * (append-only audit) as decision_kind 'conflict'; the caller sees HTTP 409
   * but the historical conclusion and its basis are preserved.
   */
  function submitPlan(input) {
    const {
      job_id,
      job_type,
      resource,
      planned_start_at,
      planned_end_at,
      decision_kind,
      idempotency_key,
    } = validate(input);

    const decidedAt = clock.now();

    return withWriteTransaction(db, () => {
      if (idempotency_key) {
        const prior = db
          .prepare(`SELECT * FROM plan_decisions WHERE request_idempotency_key = ?`)
          .get(idempotency_key);
        if (prior) return { decision: hydrateDecision(prior), idempotent_replay: true };
      }

      const exists = db
        .prepare(`SELECT 1 FROM plan_decisions WHERE job_id = ?`)
        .get(job_id);
      if (exists) {
        throw new PlanningError('DUPLICATE_JOB_ID', `job_id already used: ${job_id}`, 409);
      }

      // Freeze the version applicable at the planned time. Resolved inside
      // the write lock so a concurrent publish either fully applies or does
      // not for this decision.
      const version = versioning.resolveVersion(planned_start_at);
      const snapshot = canonicalSnapshot(version);
      const index = buildConflictIndex(version.matrix);

      // Only accepted plans occupy a resource window; recorded conflicts do not.
      const priorDecisions = db
        .prepare(
          `SELECT * FROM plan_decisions
            WHERE resource = ? AND decision_kind != 'conflict'
              AND planned_start_at < ? AND planned_end_at > ?`,
        )
        .all(resource, planned_end_at, planned_start_at);

      const basis = [];
      let conflictingJobId = null;
      for (const other of priorDecisions) {
        if (!intervalsOverlap(
          planned_start_at, planned_end_at,
          other.planned_start_at, other.planned_end_at,
        )) {
          continue;
        }
        const rule = findConflictRule(index, resource, job_type, other.job_type);
        if (rule) {
          basis.push({ job_id: other.job_id, job_type: other.job_type, rule });
          if (!conflictingJobId) conflictingJobId = other.job_id;
        }
      }

      const kind = basis.length > 0 ? 'conflict' : decision_kind;
      const info = db
        .prepare(
          `INSERT INTO plan_decisions
             (decision_kind, job_id, job_type, resource,
              planned_start_at, planned_end_at, decided_at,
              matrix_version_id, matrix_version_no, matrix_hash, matrix_snapshot,
              conflict_basis, conflicting_job_id, request_idempotency_key)
           VALUES (@decision_kind, @job_id, @job_type, @resource,
                   @planned_start_at, @planned_end_at, @decided_at,
                   @matrix_version_id, @matrix_version_no, @matrix_hash, @matrix_snapshot,
                   @conflict_basis, @conflicting_job_id, @request_idempotency_key)`,
        )
        .run({
          decision_kind: kind,
          job_id,
          job_type,
          resource,
          planned_start_at,
          planned_end_at,
          decided_at: decidedAt,
          matrix_version_id: version.id,
          matrix_version_no: version.version_no,
          matrix_hash: version.matrix_hash,
          matrix_snapshot: snapshot,
          conflict_basis: JSON.stringify(basis),
          conflicting_job_id: conflictingJobId,
          request_idempotency_key: idempotency_key ?? null,
        });

      const decision = hydrateDecision(
        db.prepare(`SELECT * FROM plan_decisions WHERE id = ?`).get(info.lastInsertRowid),
      );
      audit(db, kind, decision.id, {
        job_id,
        matrix_version_no: version.version_no,
        conflicting_job_id: conflictingJobId,
      }, decidedAt);
      return { decision, idempotent_replay: false };
    });
  }

  function listDecisions({ limit = 100, job_id, resource } = {}) {
    const clauses = [];
    const params = {};
    if (job_id) {
      clauses.push('job_id = @job_id');
      params.job_id = job_id;
    }
    if (resource) {
      clauses.push('resource = @resource');
      params.resource = resource;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.limit = Math.min(Number(limit) || 100, 500);
    return db
      .prepare(`SELECT * FROM plan_decisions ${where} ORDER BY id DESC LIMIT @limit`)
      .all(params)
      .map(hydrateDecision);
  }

  function getDecision(idOrJobId) {
    const row = findDecision(db, idOrJobId);
    if (!row) throw new PlanningError('DECISION_NOT_FOUND', 'decision not found', 404);
    return hydrateDecision(row);
  }

  /**
   * Historical replay: recompute the conflict conclusion using the EXACT
   * frozen snapshot stored on the row and verify its hash. Returns the
   * recorded conclusion plus replay evidence. Tampering with the frozen
   * snapshot yields hash_match=false; divergence yields replay_matches=false.
   */
  function replayDecision(idOrJobId) {
    const row = findDecision(db, idOrJobId);
    if (!row) throw new PlanningError('DECISION_NOT_FOUND', 'decision not found', 404);
    const recorded = hydrateDecision(row);

    const snapshotMatrix = JSON.parse(row.matrix_snapshot);
    const recomputedHash = matrixHash(snapshotMatrix);
    const hashMatch = recomputedHash === row.matrix_hash;

    const index = buildConflictIndex(snapshotMatrix);
    const prior = db
      .prepare(
        `SELECT * FROM plan_decisions
          WHERE resource = ? AND id < ?
            AND decision_kind IN ('scheduled','start_confirmed')
          ORDER BY id`,
      )
      .all(row.resource, row.id);

    const replayBasis = [];
    let conflictingJobId = null;
    for (const other of prior) {
      if (!intervalsOverlap(
        row.planned_start_at, row.planned_end_at,
        other.planned_start_at, other.planned_end_at,
      )) {
        continue;
      }
      const rule = findConflictRule(index, row.resource, row.job_type, other.job_type);
      if (rule) {
        replayBasis.push({ job_id: other.job_id, job_type: other.job_type, rule });
        if (!conflictingJobId) conflictingJobId = other.job_id;
      }
    }

    const basisMatches = jsonEqual(replayBasis, recorded.conflict_basis);

    // Accepted receipts (start_confirmed) are historical facts: an operator
    // may have forced a start. Replay must show the rule picture at the time
    // but the recorded receipt never flips into a conflict retroactively.
    const receiptStands = row.decision_kind === 'start_confirmed';
    return {
      recorded,
      replay: {
        matrix_version_no: row.matrix_version_no,
        stored_hash: row.matrix_hash,
        recomputed_hash: recomputedHash,
        hash_match: hashMatch,
        basis: replayBasis,
        conflicting_job_id: conflictingJobId,
        basis_matches_record: basisMatches,
        receipt_preserved: receiptStands,
        replay_matches: hashMatch && (basisMatches || receiptStands),
      },
    };
  }

  function validate(input) {
    for (const key of ['job_id', 'job_type', 'resource']) {
      if (typeof input[key] !== 'string' || input[key].trim() === '') {
        throw new PlanningError('INVALID_PLAN', `${key} must be a non-empty string`);
      }
    }
    const planned_start_at = toIso(input.planned_start_at ?? clock.now());
    let planned_end_at;
    if (input.planned_end_at) {
      planned_end_at = toIso(input.planned_end_at);
    } else {
      planned_end_at = new Date(
        Date.parse(planned_start_at) + DEFAULT_DURATION_MINUTES * 60000,
      ).toISOString();
    }
    if (Date.parse(planned_end_at) <= Date.parse(planned_start_at)) {
      throw new PlanningError('INVALID_PLAN', 'planned_end_at must be after planned_start_at');
    }
    const decision_kind = input.decision_kind ?? 'scheduled';
    if (!['scheduled', 'start_confirmed'].includes(decision_kind)) {
      throw new PlanningError('INVALID_PLAN', 'decision_kind must be scheduled|start_confirmed');
    }
    return {
      job_id: input.job_id,
      job_type: input.job_type,
      resource: input.resource,
      planned_start_at,
      planned_end_at,
      decision_kind,
      idempotency_key: typeof input.idempotency_key === 'string' ? input.idempotency_key : null,
    };
  }

  return { submitPlan, listDecisions, getDecision, replayDecision };
}

function findDecision(db, idOrJobId) {
  return db
    .prepare(`SELECT * FROM plan_decisions WHERE id = @q OR job_id = @q`)
    .get({ q: String(idOrJobId) });
}

function canonicalSnapshot(version) {
  // hydrate() already parsed matrix_content; re-canonicalize via the stored
  // canonical text is not possible after JSON.parse (key order preserved by
  // JSON.parse, but be safe by reusing the DB text directly).
  return version._canonical ?? JSON.stringify(version.matrix);
}
