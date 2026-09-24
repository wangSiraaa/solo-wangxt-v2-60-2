import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from './helpers.mjs';
import { withServer, http } from './http-client.mjs';

const V2_MATRIX = {
  rules: [
    { resource: 'crane-a', job_types: ['lift', 'paint'] },
    { resource: '*', job_types: ['lift', 'weld'] },
  ],
};

test('HTTP: health, OpenAPI spec and docs', async () => {
  const h = createTestHarness();
  await withServer(h.app, async (base) => {
    const health = await http(base, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    const spec = await http(base, 'GET', '/openapi.json');
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, '3.1.0');
    assert.ok(spec.body.paths['/v1/matrix/drafts/{id}/publish']);
    assert.ok(spec.body.paths['/v1/plans/{id}/replay']);

    const docs = await http(base, 'GET', '/docs');
    assert.equal(docs.status, 200);
  });
  h.close();
});

test('HTTP: full draft -> publish -> plan -> receipt -> replay flow', async () => {
  const h = createTestHarness();
  await withServer(h.app, async (base) => {
    const create = await http(base, 'POST', '/v1/matrix/drafts', {
      description: 'v2', matrix: V2_MATRIX,
    });
    assert.equal(create.status, 201);
    const draftId = create.body.id;

    // missing idempotency key -> 400
    const badPublish = await http(base, 'POST', `/v1/matrix/drafts/${draftId}/publish`, {
      effective_at: '2026-03-01T00:00:00.000Z',
    });
    assert.equal(badPublish.status, 400);

    const publish = await http(base, 'POST', `/v1/matrix/drafts/${draftId}/publish`, {
      effective_at: '2026-03-01T00:00:00.000Z',
      idempotency_key: 'http-key',
    });
    assert.equal(publish.status, 201);
    assert.equal(publish.body.version_no, 2);

    // retry is idempotent -> 200 same version
    const retry = await http(base, 'POST', `/v1/matrix/drafts/${draftId}/publish`, {
      effective_at: '2026-03-01T00:00:00.000Z',
      idempotency_key: 'http-key',
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent_replay, true);

    // overlapping publish -> 409 with structured code
    const d2 = await http(base, 'POST', '/v1/matrix/drafts', { matrix: { rules: [] } });
    const overlap = await http(base, 'POST', `/v1/matrix/drafts/${d2.body.id}/publish`, {
      effective_at: '2026-02-01T00:00:00.000Z',
      idempotency_key: 'http-overlap',
    });
    assert.equal(overlap.status, 409);
    assert.equal(overlap.body.error.code, 'OVERLAPPING_EFFECTIVE_WINDOW');

    // accepted plan under v2
    const p1 = await http(base, 'POST', '/v1/plans', {
      job_id: 'H1', job_type: 'lift', resource: 'yard',
      planned_start_at: '2026-04-01T08:00:00.000Z',
      planned_end_at: '2026-04-01T10:00:00.000Z',
    });
    assert.equal(p1.status, 201);
    assert.equal(p1.body.matrix_version_no, 2);

    // conflict -> 409 but body is the persisted decision receipt
    const p2 = await http(base, 'POST', '/v1/plans', {
      job_id: 'H2', job_type: 'weld', resource: 'yard',
      planned_start_at: '2026-04-01T09:00:00.000Z',
      planned_end_at: '2026-04-01T11:00:00.000Z',
    });
    assert.equal(p2.status, 409);
    assert.equal(p2.body.outcome, 'conflict');
    assert.equal(p2.body.conflict_basis[0].job_id, 'H1');

    // get receipt and replay by job_id
    const receipt = await http(base, 'GET', '/v1/plans/H2');
    assert.equal(receipt.status, 200);
    const replay = await http(base, 'GET', '/v1/plans/H2/replay');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay.replay_matches, true);

    // version query endpoints (clock is 2026-01 in the harness, so "current"
    // is still v1; the April plan above resolved v2 by its planned instant)
    const current = await http(base, 'GET', '/v1/matrix/versions/current');
    assert.equal(current.body.version_no, 1);
    const currentAtCutover = await http(base, 'GET', '/v1/matrix/versions/2');
    assert.equal(currentAtCutover.body.version_no, 2);
    const byNo = await http(base, 'GET', '/v1/matrix/versions/1');
    assert.equal(byNo.body.version_no, 1);
    const list = await http(base, 'GET', '/v1/matrix/versions');
    assert.equal(list.body.versions.length, 2);

    // audit trail
    const events = await http(base, 'GET', '/v1/audit/events?aggregate=matrix_version');
    assert.ok(events.body.events.some((e) => e.event_type === 'published'));
  });
  h.close();
});

test('HTTP: plan idempotency key replays the original decision with 200', async () => {
  const h = createTestHarness();
  await withServer(h.app, async (base) => {
    const payload = {
      job_id: 'K1', job_type: 'lift', resource: 'crane-a',
      planned_start_at: '2026-02-01T08:00:00.000Z',
      planned_end_at: '2026-02-01T09:00:00.000Z',
      idempotency_key: 'plan-key',
    };
    const first = await http(base, 'POST', '/v1/plans', payload);
    assert.equal(first.status, 201);
    const second = await http(base, 'POST', '/v1/plans', { ...payload, job_type: 'paint' });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent_replay, true);
    assert.equal(second.body.job_type, 'lift');
  });
  h.close();
});

test('HTTP: validation errors and unknown resources are structured', async () => {
  const h = createTestHarness();
  await withServer(h.app, async (base) => {
    const bad = await http(base, 'POST', '/v1/plans', { job_id: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

    const missing = await http(base, 'GET', '/v1/plans/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'DECISION_NOT_FOUND');
  });
  h.close();
});
