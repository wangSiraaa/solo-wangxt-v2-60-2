/**
 * Matrix versioning service: drafts, publish, effective-window selection.
 *
 * Effective windows of PUBLISHED versions are a disjoint partition of time:
 *
 *   v1: [1970-01-01, t2)
 *   v2: [t2, t3)
 *   v3: [t3, NULL)   (NULL == currently in force)
 *
 * Publishing rules (enforced inside one IMMEDIATE transaction):
 *   1. idempotency key reuse  -> return the already-published version,
 *      regardless of which draft it names (safe retry of the same request);
 *   2. effective_at must be strictly later than the newest published
 *      effective_at and no existing closed window may contain it, otherwise
 *      OVERLAPPING_EFFECTIVE_WINDOW is raised;
 *   3. the previously-open version's window is closed atomically.
 */
import {
  canonicalize,
  matrixHash,
  normalizeMatrix,
  ValidationError,
} from '../domain/matrix.mjs';
import { toIso } from '../domain/clock.mjs';
import { withWriteTransaction } from './index.mjs';

export class VersioningError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = 'VersioningError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const insertVersion = (db) =>
  db.prepare(
    `INSERT INTO matrix_versions
       (version_no, status, description, matrix_content, matrix_hash,
        effective_at, superseded_at, idempotency_key, created_at, published_at)
     VALUES (NULL, 'draft', @description, @matrix_content, @matrix_hash,
             NULL, NULL, NULL, @created_at, NULL)`,
  );

const insertRule = (db) =>
  db.prepare(
    `INSERT INTO matrix_rules (version_id, rule_index, resource, job_type_a, job_type_b, mode)
   VALUES (@version_id, @rule_index, @resource, @job_type_a, @job_type_b, 'mutex')`,
  );

function audit(db, eventType, aggregateId, payload, at) {
  db.prepare(
    `INSERT INTO audit_events (event_type, aggregate, aggregate_id, payload, occurred_at)
     VALUES (@event_type, 'matrix_version', @aggregate_id, @payload, @at)`,
  ).run({
    event_type: eventType,
    aggregate_id: String(aggregateId),
    payload: JSON.stringify(payload),
    at,
  });
}

function writeRules(db, versionId, content) {
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
}

function hydrate(row) {
  return {
    id: row.id,
    version_no: row.version_no,
    status: row.status,
    description: row.description,
    effective_at: row.effective_at,
    superseded_at: row.superseded_at,
    created_at: row.created_at,
    published_at: row.published_at,
    matrix: JSON.parse(row.matrix_content),
    matrix_hash: row.matrix_hash,
    // canonical bytes (hash is computed over these); used to freeze snapshots
    _canonical: row.matrix_content,
  };
}

export function createVersioningService(db, clock) {
  function createDraft({ matrix, description }) {
    const content = normalizeMatrix(matrix);
    const canonical = canonicalize(content);
    const hash = matrixHash(content);
    const now = clock.now();

    const id = withWriteTransaction(db, () => {
      const info = insertVersion(db).run({
        description: description ?? null,
        matrix_content: canonical,
        matrix_hash: hash,
        created_at: now,
      });
      writeRules(db, info.lastInsertRowid, content);
      audit(db, 'draft_created', info.lastInsertRowid, { matrix_hash: hash }, now);
      return info.lastInsertRowid;
    });
    return getDraft(id);
  }

  function updateDraft(draftId, { matrix, description }) {
    const content = normalizeMatrix(matrix);
    const canonical = canonicalize(content);
    const hash = matrixHash(content);
    const now = clock.now();

    withWriteTransaction(db, () => {
      const draft = db
        .prepare(`SELECT * FROM matrix_versions WHERE id = ?`)
        .get(draftId);
      if (!draft) throw new VersioningError('DRAFT_NOT_FOUND', 'draft not found', 404);
      if (draft.status !== 'draft') {
        throw new VersioningError(
          'NOT_A_DRAFT',
          `version ${draft.version_no} is already published and immutable`,
          409,
        );
      }
      db.prepare(
        `UPDATE matrix_versions
            SET description = @description, matrix_content = @matrix_content,
                matrix_hash = @matrix_hash
          WHERE id = @id`,
      ).run({
        id: draftId,
        description: description ?? draft.description,
        matrix_content: canonical,
        matrix_hash: hash,
      });
      db.prepare(`DELETE FROM matrix_rules WHERE version_id = ?`).run(draftId);
      writeRules(db, draftId, content);
      audit(db, 'draft_updated', draftId, { matrix_hash: hash }, now);
    });
    return getDraft(draftId);
  }

  /**
   * Publish a draft.
   * @param {object} p
   * @param {number} p.draftId
   * @param {string} [p.effectiveAt]  default: now (must not be in the past of
   *                                  the newest effective window)
   * @param {string} [p.idempotencyKey] request key; retrying with the same
   *                                    key returns the same published version
   */
  function publishDraft({ draftId, effectiveAt, idempotencyKey }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new ValidationError('idempotency_key is required for publish');
    }
    const now = clock.now();
    const requestedAt = toIso(effectiveAt ?? now);

    try {
      return withWriteTransaction(db, () => {
        // (1) idempotent retry: same key -> same result, no second version.
        const existing = db
          .prepare(
            `SELECT * FROM matrix_versions WHERE idempotency_key = ?`,
          )
          .get(idempotencyKey);
        if (existing) {
          audit(db, 'publish_idempotent_replay', existing.id, { idempotency_key: idempotencyKey }, now);
          return { version: hydrate(existing), idempotent_replay: true };
        }

        const draft = db
          .prepare(`SELECT * FROM matrix_versions WHERE id = ?`)
          .get(draftId);
        if (!draft) throw new VersioningError('DRAFT_NOT_FOUND', 'draft not found', 404);
        if (draft.status !== 'draft') {
          throw new VersioningError(
            'DRAFT_ALREADY_PUBLISHED',
            'draft has already been published',
            409,
          );
        }

        // (2) Effective-window overlap check.
        //
        // Published windows are a disjoint half-open partition of time and
        // cutovers are append-only: a new boundary must be strictly later than
        // the newest boundary, and then
        //
        //   ... latest: [t_latest, t_new)   new: [t_new, infinity)
        //
        // An equal or earlier effective_at would overlap a window whose
        // contents are already part of history and is rejected. The IMMEDIATE
        // write lock serializes concurrent publishers: two cutovers at the
        // same instant produce exactly one winner, and the other is rejected
        // (or, for the same idempotency key, replays the winner).
        const latest = db
          .prepare(
            `SELECT * FROM matrix_versions
            WHERE status = 'published'
            ORDER BY effective_at DESC, id DESC LIMIT 1`,
          )
          .get();

        if (latest && Date.parse(requestedAt) <= Date.parse(latest.effective_at)) {
          throw new VersioningError(
            'OVERLAPPING_EFFECTIVE_WINDOW',
            `effective_at (${requestedAt}) must be later than the newest published effective_at (${latest.effective_at})`,
            409,
            {
              reason: 'OVERLAPPING_EFFECTIVE_WINDOW',
              requested_effective_at: requestedAt,
              latest_effective_at: latest.effective_at,
            },
          );
        }

        // (3) version numbers are an append-only commit sequence; effective
        // windows themselves are ordered by effective_at. Close the open
        // window at the new boundary.
        const nextNo = (latest?.version_no ?? 0) + 1;

        db.prepare(
          `UPDATE matrix_versions
            SET status = 'published', version_no = ?, effective_at = ?,
                superseded_at = NULL, idempotency_key = ?, published_at = ?
          WHERE id = ?`,
        ).run(nextNo, requestedAt, idempotencyKey, now, draft.id);

        if (latest) {
          db.prepare(
            `UPDATE matrix_versions SET superseded_at = ? WHERE id = ?`,
          ).run(requestedAt, latest.id);
        }

        audit(db, 'published', draft.id, {
          version_no: nextNo,
          effective_at: requestedAt,
          idempotency_key: idempotencyKey,
          superseded_version: latest ? latest.version_no : null,
        }, now);

      return { version: getVersion(draft.id), idempotent_replay: false };
    });
    } catch (err) {
      // A same-instant publish can lose the race at the storage unique index
      // rather than at our check; normalize it to the same domain error.
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' && /matrix_versions/.test(err.message ?? '')) {
        err = new VersioningError(
          'OVERLAPPING_EFFECTIVE_WINDOW',
          `another version is already effective at ${requestedAt}`,
          409,
          { reason: 'OVERLAPPING_EFFECTIVE_WINDOW', requested_effective_at: requestedAt },
        );
      }
      // Persist rejection evidence even though the decision transaction rolled
      // back; the audit trail is append-only and independent of the outcome.
      if (
        err instanceof VersioningError &&
        (err.code === 'OVERLAPPING_EFFECTIVE_WINDOW' || err.code === 'DRAFT_ALREADY_PUBLISHED')
      ) {
        audit(db, 'publish_rejected', draftId, {
          reason: err.code,
          requested_at: requestedAt,
          idempotency_key: idempotencyKey,
          details: err.details ?? null,
        }, now);
      }
      throw err;
    }
  }

  /** Select the matrix version in force at a given instant (half-open windows). */
  function resolveVersion(at) {
    const when = toIso(at);
    const row = db
      .prepare(
        `SELECT * FROM matrix_versions
          WHERE status = 'published' AND effective_at <= ?
          ORDER BY effective_at DESC, id DESC LIMIT 1`,
      )
      .get(when);
    if (!row) {
      throw new VersioningError(
        'NO_MATRIX_VERSION',
        'no published matrix version covers that point in time',
        500,
      );
    }
    return hydrate(row);
  }

  function currentVersion() {
    return resolveVersion(clock.now());
  }

  function listVersions() {
    return db
      .prepare(
        `SELECT * FROM matrix_versions
          WHERE status = 'published' ORDER BY version_no`,
      )
      .all()
      .map(hydrate);
  }

  function listDrafts() {
    return db
      .prepare(`SELECT * FROM matrix_versions WHERE status = 'draft' ORDER BY id`)
      .all()
      .map(hydrate);
  }

  function getVersion(idOrNo) {
    const row = db
      .prepare(
        `SELECT * FROM matrix_versions
          WHERE id = ? OR (status='published' AND version_no = ?)`,
      )
      .get(idOrNo, idOrNo);
    if (!row) throw new VersioningError('VERSION_NOT_FOUND', 'version not found', 404);
    return hydrate(row);
  }

  function getDraft(id) {
    const row = db
      .prepare(`SELECT * FROM matrix_versions WHERE id = ? AND status = 'draft'`)
      .get(id);
    if (!row) throw new VersioningError('DRAFT_NOT_FOUND', 'draft not found', 404);
    return hydrate(row);
  }

  return {
    createDraft,
    updateDraft,
    publishDraft,
    resolveVersion,
    currentVersion,
    listVersions,
    listDrafts,
    getVersion,
    getDraft,
  };
}
