import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tempDbPath, prepareLegacyDatabase } from './helpers.mjs';
import { openDb } from '../src/db/index.mjs';
import { LEGACY_MATRIX } from '../src/db/legacy.mjs';
import { canonicalize, matrixHash, normalizeMatrix } from '../src/domain/matrix.mjs';

test('fresh database: baseline v1 is published effective at the epoch', () => {
  const db = openDb(tempDbPath());
  const v1 = db
    .prepare(`SELECT * FROM matrix_versions WHERE version_no = 1`)
    .get();
  assert.equal(v1.status, 'published');
  assert.equal(v1.effective_at, '1970-01-01T00:00:00.000Z');
  assert.equal(v1.superseded_at, null);
  assert.equal(v1.matrix_hash, matrixHash(normalizeMatrix(LEGACY_MATRIX)));

  const versions = db
    .prepare(`SELECT COUNT(*) AS c FROM matrix_versions WHERE status='published'`)
    .get();
  assert.equal(versions.c, 1);
  db.close();
});

test('migration is idempotent: reopening the DB does not duplicate v1', () => {
  const path = tempDbPath();
  const a = openDb(path);
  a.close();
  const b = openDb(path);
  const count = b
    .prepare(`SELECT COUNT(*) AS c FROM matrix_versions WHERE version_no = 1`)
    .get();
  assert.equal(count.c, 1);
  b.close();
});

test('legacy matrix rows are safely imported as v1 and legacy plans frozen', () => {
  const path = tempDbPath();
  prepareLegacyDatabase(path, {
    pairs: [
      { resource: 'crane-a', job_type_a: 'lift', job_type_b: 'paint' },
      { resource: 'crane-a', job_type_a: 'inspect', job_type_b: 'paint' },
    ],
    plans: [
      {
        id: 'OLD-1',
        job_type: 'lift',
        resource: 'crane-a',
        planned_start_at: '2025-06-01T08:00:00.000Z',
        planned_end_at: '2025-06-01T09:00:00.000Z',
        status: 'scheduled',
      },
      {
        id: 'OLD-2',
        job_type: 'paint',
        resource: 'crane-a',
        planned_start_at: '2025-06-01T08:30:00.000Z',
        planned_end_at: '2025-06-01T09:30:00.000Z',
        status: 'rejected',
      },
    ],
  });

  const db = openDb(path);

  const v1 = db.prepare(`SELECT * FROM matrix_versions WHERE version_no = 1`).get();
  assert.match(v1.description, /legacy_mutex_matrix/);
  const matrix = JSON.parse(v1.matrix_content);
  assert.equal(matrix.rules.length, 1);
  assert.deepEqual(matrix.rules[0].job_types, ['inspect', 'lift', 'paint']);

  const decisions = db
    .prepare(`SELECT * FROM plan_decisions ORDER BY id`)
    .all();
  assert.equal(decisions.length, 2);
  const [old1, old2] = decisions;
  assert.equal(old1.matrix_version_no, 1);
  assert.equal(old1.decision_kind, 'scheduled');
  assert.equal(old2.decision_kind, 'conflict');
  assert.equal(old2.conflicting_job_id, 'OLD-1');
  const basis = JSON.parse(old2.conflict_basis);
  assert.equal(basis[0].job_id, 'OLD-1');
  assert.deepEqual(basis[0].rule.job_types.sort(), ['lift', 'paint']);
  // full frozen snapshot present on every imported row
  for (const d of decisions) {
    assert.equal(d.matrix_snapshot, canonicalize(matrix));
    assert.equal(d.matrix_hash, v1.matrix_hash);
  }
  db.close();
});

test('legacy empty matrix falls back to baseline v1', () => {
  const path = tempDbPath();
  prepareLegacyDatabase(path, { pairs: [], plans: [] });
  const db = openDb(path);
  const v1 = db.prepare(`SELECT * FROM matrix_versions WHERE version_no = 1`).get();
  assert.equal(v1.matrix_hash, matrixHash(normalizeMatrix(LEGACY_MATRIX)));
  db.close();
});

test('migration leaves no partial/duplicate state if rerun', () => {
  const path = tempDbPath();
  prepareLegacyDatabase(path, {
    pairs: [{ resource: 'r1', job_type_a: 'a', job_type_b: 'b' }],
  });
  openDb(path).close();
  const db = openDb(path); // second open: 003 must not re-run
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS c FROM matrix_versions`).get().c,
    1,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS c FROM migrations WHERE name='003_legacy_safe_migration'`).get().c,
    1,
  );
  db.close();
});

test('direct tampering with published rows and history is blocked by triggers', () => {
  const db = openDb(tempDbPath());
  assert.throws(
    () => db.prepare(`UPDATE matrix_versions SET matrix_hash = 'x' WHERE version_no = 1`).run(),
    /immutable/,
  );
  assert.throws(
    () => db.prepare(`DELETE FROM matrix_versions WHERE version_no = 1`).run(),
    /cannot be deleted/,
  );
  db.close();
});

test('the raw legacy database file genuinely exists before migration (fixture check)', () => {
  const path = tempDbPath();
  prepareLegacyDatabase(path, { pairs: [{ resource: 'r', job_type_a: 'a', job_type_b: 'b' }] });
  const raw = new Database(path, { readonly: true });
  const rows = raw.prepare(`SELECT * FROM legacy_mutex_matrix`).all();
  assert.equal(rows.length, 1);
  assert.throws(() => raw.prepare(`SELECT * FROM matrix_versions`).all());
  raw.close();
});
