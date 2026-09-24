import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from './helpers.mjs';

const V2_MATRIX = {
  rules: [
    // v1 kept crane-a lift|paint and oven-1 cure|weld;
    // NEW v2: lift vs weld on the global resource
    { resource: 'crane-a', job_types: ['lift', 'paint'] },
    { resource: 'oven-1', job_types: ['cure', 'weld'] },
    { resource: '*', job_types: ['lift', 'weld'] },
  ],
};

function publishV2(h, key = 'pub-v2', at = '2026-03-01T00:00:00.000Z') {
  const d = h.versioning.createDraft({ description: 'v2', matrix: V2_MATRIX });
  return h.versioning.publishDraft({ draftId: d.id, effectiveAt: at, idempotencyKey: key });
}

test('old plans are always judged by v1, even after v2 is published', () => {
  const h = createTestHarness();
  publishV2(h);

  // plan fully BEFORE v2 effective time -> must freeze v1
  const before = h.planning.submitPlan({
    job_id: 'B1',
    job_type: 'weld',
    resource: 'yard',
    planned_start_at: '2026-02-10T08:00:00.000Z',
    planned_end_at: '2026-02-10T09:00:00.000Z',
  });
  assert.equal(before.decision.matrix_version_no, 1);

  const before2 = h.planning.submitPlan({
    job_id: 'B2',
    job_type: 'paint',
    resource: 'yard',
    planned_start_at: '2026-02-10T08:30:00.000Z',
    planned_end_at: '2026-02-10T09:30:00.000Z',
  });
  // weld|paint conflicts via the v1 global rule
  assert.equal(before2.decision.decision_kind, 'conflict');
  assert.equal(before2.decision.matrix_version_no, 1);
  assert.equal(before2.decision.conflicting_job_id, 'B1');
  h.close();
});

test('new plans after v2 publication are judged by v2 and its new rule', () => {
  const h = createTestHarness();
  publishV2(h);

  const lift = h.planning.submitPlan({
    job_id: 'A1',
    job_type: 'lift',
    resource: 'yard',
    planned_start_at: '2026-04-10T08:00:00.000Z',
    planned_end_at: '2026-04-10T09:00:00.000Z',
  });
  assert.equal(lift.decision.matrix_version_no, 2);

  const weld = h.planning.submitPlan({
    job_id: 'A2',
    job_type: 'weld',
    resource: 'yard',
    planned_start_at: '2026-04-10T08:30:00.000Z',
    planned_end_at: '2026-04-10T09:30:00.000Z',
  });
  // lift|weld only conflicts under v2
  assert.equal(weld.decision.matrix_version_no, 2);
  assert.equal(weld.decision.decision_kind, 'conflict');
  assert.equal(weld.decision.conflicting_job_id, 'A1');
  assert.equal(weld.decision.conflict_basis[0].rule.rule_index, 2);

  // sanity: the same pair BEFORE v2 would have been accepted, proving the
  // historical v1 plan keeps its old conclusion
  const oldLift = h.planning.submitPlan({
    job_id: 'O1',
    job_type: 'lift',
    resource: 'yard',
    planned_start_at: '2026-02-10T08:00:00.000Z',
    planned_end_at: '2026-02-10T09:00:00.000Z',
  });
  const oldWeld = h.planning.submitPlan({
    job_id: 'O2',
    job_type: 'weld',
    resource: 'yard',
    planned_start_at: '2026-02-10T08:30:00.000Z',
    planned_end_at: '2026-02-10T09:30:00.000Z',
  });
  assert.equal(oldLift.decision.matrix_version_no, 1);
  assert.equal(oldWeld.decision.decision_kind, 'scheduled');
  h.close();
});

test('cross-effective-boundary planning selects versions per planned time', () => {
  const h = createTestHarness();
  publishV2(h, 'k2', '2026-03-01T00:00:00.000Z');
  const d3 = h.versioning.createDraft({
    matrix: { rules: [{ resource: 'crane-a', job_types: ['lift', 'paint'] }] },
  });
  h.versioning.publishDraft({
    draftId: d3.id,
    effectiveAt: '2026-06-01T00:00:00.000Z',
    idempotencyKey: 'k3',
  });

  // Submitted "now" (clock at 2026-01) but scheduled into each window: the
  // planned instant, not submission time, selects the frozen version.
  const inV1 = h.planning.submitPlan({
    job_id: 'T1', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-01-20T08:00:00.000Z',
    planned_end_at: '2026-01-20T09:00:00.000Z',
  });
  const inV2 = h.planning.submitPlan({
    job_id: 'T2', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-04-20T08:00:00.000Z',
    planned_end_at: '2026-04-20T09:00:00.000Z',
  });
  const inV3 = h.planning.submitPlan({
    job_id: 'T3', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-07-20T08:00:00.000Z',
    planned_end_at: '2026-07-20T09:00:00.000Z',
  });
  assert.deepEqual(
    [inV1.decision.matrix_version_no, inV2.decision.matrix_version_no, inV3.decision.matrix_version_no],
    [1, 2, 3],
  );
  h.close();
});

test('decision rows freeze the complete matrix snapshot, hash and explicit basis', () => {
  const h = createTestHarness();
  publishV2(h);
  h.planning.submitPlan({
    job_id: 'P1', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-04-01T08:00:00.000Z',
    planned_end_at: '2026-04-01T09:00:00.000Z',
  });
  const conflict = h.planning.submitPlan({
    job_id: 'P2', job_type: 'paint', resource: 'crane-a',
    planned_start_at: '2026-04-01T08:30:00.000Z',
    planned_end_at: '2026-04-01T09:30:00.000Z',
  });

  const row = h.db.prepare(`SELECT * FROM plan_decisions WHERE job_id='P2'`).get();
  const snapshot = JSON.parse(row.matrix_snapshot);
  assert.equal(snapshot.rules.length, 3);
  const v2 = h.versioning.getVersion(2);
  assert.equal(row.matrix_hash, v2.matrix_hash);
  assert.equal(conflict.decision.conflict_basis[0].rule.resource, 'crane-a');

  // After publishing v3 with a totally different matrix, P2's row is untouched
  const d3 = h.versioning.createDraft({ matrix: { rules: [] } });
  h.versioning.publishDraft({
    draftId: d3.id, effectiveAt: '2026-06-01T00:00:00.000Z', idempotencyKey: 'v3',
  });
  const rowAfter = h.db.prepare(`SELECT * FROM plan_decisions WHERE job_id='P2'`).get();
  assert.equal(rowAfter.matrix_version_no, 2);
  assert.equal(rowAfter.matrix_snapshot, row.matrix_snapshot);
  assert.equal(rowAfter.conflict_basis, row.conflict_basis);
  h.close();
});

test('plan submission idempotency: retried request returns the original decision', () => {
  const h = createTestHarness();
  const input = {
    job_id: 'I1', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-02-01T08:00:00.000Z',
    planned_end_at: '2026-02-01T09:00:00.000Z',
    idempotency_key: 'client-key-1',
  };
  const first = h.planning.submitPlan(input);
  const second = h.planning.submitPlan({ ...input, job_type: 'paint' }); // mutated retry
  assert.equal(first.decision.id, second.decision.id);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.decision.job_type, 'lift'); // original wins
  assert.equal(
    h.db.prepare(`SELECT COUNT(*) c FROM plan_decisions WHERE job_id='I1'`).get().c,
    1,
  );
  h.close();
});

test('conflicting submission is persisted as an append-only conflict decision', () => {
  const h = createTestHarness();
  h.planning.submitPlan({
    job_id: 'X1', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-02-01T08:00:00.000Z',
    planned_end_at: '2026-02-01T09:00:00.000Z',
  });
  const bad = h.planning.submitPlan({
    job_id: 'X2', job_type: 'paint', resource: 'crane-a',
    planned_start_at: '2026-02-01T08:30:00.000Z',
    planned_end_at: '2026-02-01T09:30:00.000Z',
  });
  assert.equal(bad.decision.decision_kind, 'conflict');
  // rejected plan must not block another later plan on the same resource
  const after = h.planning.submitPlan({
    job_id: 'X3', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-02-01T10:00:00.000Z',
    planned_end_at: '2026-02-01T11:00:00.000Z',
  });
  assert.equal(after.decision.decision_kind, 'scheduled');

  assert.throws(
    () => h.db.prepare(`UPDATE plan_decisions SET decision_kind='scheduled' WHERE job_id='X2'`).run(),
    /append-only/,
  );
  assert.throws(
    () => h.db.prepare(`DELETE FROM plan_decisions WHERE job_id='X2'`).run(),
    /append-only/,
  );
  h.close();
});

test('non-overlapping times or unrelated job types do not conflict', () => {
  const h = createTestHarness();
  h.planning.submitPlan({
    job_id: 'N1', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-02-01T08:00:00.000Z',
    planned_end_at: '2026-02-01T09:00:00.000Z',
  });
  const adjacent = h.planning.submitPlan({
    job_id: 'N2', job_type: 'paint', resource: 'crane-a',
    planned_start_at: '2026-02-01T09:00:00.000Z',
    planned_end_at: '2026-02-01T10:00:00.000Z',
  });
  assert.equal(adjacent.decision.decision_kind, 'scheduled'); // touching intervals don't overlap
  const unrelated = h.planning.submitPlan({
    job_id: 'N3', job_type: 'lift', resource: 'crane-a',
    planned_start_at: '2026-02-01T08:30:00.000Z',
    planned_end_at: '2026-02-01T08:45:00.000Z',
  });
  assert.equal(unrelated.decision.decision_kind, 'scheduled'); // lift|lift allowed
  h.close();
});
