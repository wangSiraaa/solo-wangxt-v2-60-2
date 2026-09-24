import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness, tempDbPath, prepareLegacyDatabase } from './helpers.mjs';
import { openDb } from '../src/db/index.mjs';
import { createServices } from '../src/db/services.mjs';
import { createClock } from '../src/domain/clock.mjs';

const V2_MATRIX = {
  rules: [
    { resource: 'crane-a', job_types: ['lift', 'paint'] },
    { resource: 'oven-1', job_types: ['cure', 'weld'] },
    { resource: '*', job_types: ['lift', 'weld'] },
  ],
};

test('after restart, historical conflict reason and version snapshot still replay exactly', () => {
  const path = tempDbPath();

  // phase 1: make history
  {
    const h = createTestHarness({ path });
    const d = h.versioning.createDraft({ matrix: V2_MATRIX });
    h.versioning.publishDraft({
      draftId: d.id,
      effectiveAt: '2026-03-01T00:00:00.000Z',
      idempotencyKey: 'v2',
    });
    h.planning.submitPlan({
      job_id: 'R1', job_type: 'lift', resource: 'yard',
      planned_start_at: '2026-04-01T08:00:00.000Z',
      planned_end_at: '2026-04-01T10:00:00.000Z',
    });
    h.planning.submitPlan({
      job_id: 'R2', job_type: 'weld', resource: 'yard',
      planned_start_at: '2026-04-01T09:00:00.000Z',
      planned_end_at: '2026-04-01T11:00:00.000Z',
    });
    h.planning.submitPlan({
      job_id: 'R0', job_type: 'lift', resource: 'yard',
      planned_start_at: '2026-02-01T08:00:00.000Z',
      planned_end_at: '2026-02-01T09:00:00.000Z',
    });
    h.planning.submitPlan({
      job_id: 'R0b', job_type: 'weld', resource: 'yard',
      planned_start_at: '2026-02-01T08:30:00.000Z',
      planned_end_at: '2026-02-01T09:30:00.000Z',
    });
    h.close();
  }

  // phase 2: brand new process/connection, no in-memory state
  {
    const db = openDb(path);
    const services = createServices({ db, clock: createClock() });

    // publish a v3 in the new process; old decisions must be unaffected
    const d3 = services.versioning.createDraft({ matrix: { rules: [] } });
    services.versioning.publishDraft({
      draftId: d3.id,
      effectiveAt: '2026-08-01T00:00:00.000Z',
      idempotencyKey: 'v3',
    });

    const replayV2Conflict = services.planning.replayDecision('R2');
    assert.equal(replayV2Conflict.recorded.matrix_version_no, 2);
    assert.equal(replayV2Conflict.recorded.conflicting_job_id, 'R1');
    assert.equal(replayV2Conflict.replay.hash_match, true);
    assert.equal(replayV2Conflict.replay.basis_matches_record, true);
    assert.equal(replayV2Conflict.replay.replay_matches, true);
    assert.equal(replayV2Conflict.recorded.matrix_snapshot.rules.length, 3);
    assert.deepEqual(replayV2Conflict.replay.basis[0].rule.job_types, ['lift', 'weld']);

    const replayV1Accepted = services.planning.replayDecision('R0b');
    assert.equal(replayV1Accepted.recorded.matrix_version_no, 1);
    assert.equal(replayV1Accepted.replay.replay_matches, true);
    // lift|weld was NOT a v1 rule: no basis under the frozen v1 snapshot
    assert.equal(replayV1Accepted.replay.basis.length, 0);

    // GET receipt directly
    const receipt = services.planning.getDecision('R2');
    assert.equal(receipt.matrix_hash, replayV2Conflict.recorded.matrix_hash);
    db.close();
  }
});

test('tampering with a frozen snapshot is detectable on replay', () => {
  const path = tempDbPath();
  {
    const h = createTestHarness({ path });
    h.planning.submitPlan({
      job_id: 'M1', job_type: 'lift', resource: 'crane-a',
      planned_start_at: '2026-02-01T08:00:00.000Z',
      planned_end_at: '2026-02-01T09:00:00.000Z',
    });
    h.planning.submitPlan({
      job_id: 'M2', job_type: 'paint', resource: 'crane-a',
      planned_start_at: '2026-02-01T08:30:00.000Z',
      planned_end_at: '2026-02-01T09:30:00.000Z',
    });
    h.close();
  }

  // bypass triggers to simulate physical/storage-level tampering
  const raw = openDb(path);
  raw.pragma('recursive_triggers = OFF');
  raw.exec(`DROP TRIGGER IF EXISTS trg_plan_decisions_no_update`);
  raw.prepare(
    `UPDATE plan_decisions SET matrix_snapshot = '{"schema_version":1,"rules":[]}' WHERE job_id='M2'`,
  ).run();
  raw.close();

  const db = openDb(path);
  const services = createServices({ db, clock: createClock() });
  const r = services.planning.replayDecision('M2');
  assert.equal(r.replay.hash_match, false);
  assert.equal(r.replay.replay_matches, false);
  db.close();
});

test('legacy plans replay under v1 after migration and restart', () => {
  const path = tempDbPath();
  prepareLegacyDatabase(path, {
    pairs: [{ resource: 'crane-a', job_type_a: 'lift', job_type_b: 'paint' }],
    plans: [
      {
        id: 'L1', job_type: 'lift', resource: 'crane-a',
        planned_start_at: '2025-05-01T08:00:00.000Z',
        planned_end_at: '2025-05-01T10:00:00.000Z',
        status: 'scheduled',
      },
      {
        id: 'L2', job_type: 'paint', resource: 'crane-a',
        planned_start_at: '2025-05-01T09:00:00.000Z',
        planned_end_at: '2025-05-01T11:00:00.000Z',
        status: 'rejected',
      },
    ],
  });
  openDb(path).close();

  const db = openDb(path);
  const services = createServices({ db, clock: createClock() });
  const r = services.planning.replayDecision('L2');
  assert.equal(r.recorded.matrix_version_no, 1);
  assert.equal(r.replay.hash_match, true);
  assert.equal(r.replay.conflicting_job_id, 'L1');
  assert.equal(r.replay.basis_matches_record, true);
  assert.equal(r.replay.replay_matches, true);
  db.close();
});
