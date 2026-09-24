import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHarness } from './helpers.mjs';

const V2_MATRIX = {
  rules: [
    { resource: 'crane-a', job_types: ['lift', 'paint'] },
    { resource: 'oven-1', job_types: ['cure', 'weld'] },
    // NEW v2 rule: lift vs weld globally
    { resource: '*', job_types: ['lift', 'weld'] },
  ],
};

test('draft create/update lifecycle and canonical hashing', () => {
  const h = createTestHarness();
  const d = h.versioning.createDraft({ description: 'v2 work', matrix: V2_MATRIX });
  assert.equal(d.status, 'draft');
  assert.equal(d.version_no, null);
  assert.equal(d.matrix.rules.length, 3);

  const d2 = h.versioning.updateDraft(d.id, {
    matrix: { rules: V2_MATRIX.rules.slice(0, 2) },
  });
  assert.notEqual(d2.matrix_hash, d.matrix_hash);

  // editing a published version fails
  const d3 = h.versioning.createDraft({ matrix: V2_MATRIX });
  h.versioning.publishDraft({
    draftId: d3.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'pub-1',
  });
  assert.throws(
    () => h.versioning.updateDraft(d3.id, { matrix: { rules: [] } }),
    /already published/,
  );
  h.close();
});

test('publish assigns sequential versions and closes the previous window atomically', () => {
  const h = createTestHarness();
  const d1 = h.versioning.createDraft({ matrix: V2_MATRIX });
  h.versioning.publishDraft({
    draftId: d1.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'pub-1',
  });
  const d2 = h.versioning.createDraft({ matrix: { rules: [] } });
  h.versioning.publishDraft({
    draftId: d2.id,
    effectiveAt: '2026-06-01T00:00:00.000Z',
    idempotencyKey: 'pub-2',
  });

  const versions = h.versioning.listVersions();
  assert.deepEqual(
    versions.map((v) => [v.version_no, v.effective_at, v.superseded_at]),
    [
      [1, '1970-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      [2, '2026-03-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'],
      [3, '2026-06-01T00:00:00.000Z', null],
    ],
  );

  // boundaries resolve half-open: the exact instant belongs to the new version
  assert.equal(h.versioning.resolveVersion('2026-02-28T23:59:59.999Z').version_no, 1);
  assert.equal(h.versioning.resolveVersion('2026-03-01T00:00:00.000Z').version_no, 2);
  assert.equal(h.versioning.resolveVersion('2026-05-31T23:59:59.999Z').version_no, 2);
  assert.equal(h.versioning.resolveVersion('2026-06-01T00:00:00.000Z').version_no, 3);
  h.close();
});

test('overlapping effective windows are explicitly rejected', () => {
  const h = createTestHarness();
  h.versioning.createDraft({ matrix: V2_MATRIX });
  const a = h.versioning.createDraft({ matrix: V2_MATRIX });
  h.versioning.publishDraft({
    draftId: a.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'a',
  });

  // same effective_at as newest
  const b = h.versioning.createDraft({ matrix: V2_MATRIX });
  assert.throws(
    () =>
      h.versioning.publishDraft({
        draftId: b.id,
        effectiveAt: '2026-03-01T00:00:00.000Z',
        idempotencyKey: 'b',
      }),
    (err) => err.code === 'OVERLAPPING_EFFECTIVE_WINDOW',
  );

  // earlier than newest
  const c = h.versioning.createDraft({ matrix: V2_MATRIX });
  assert.throws(
    () =>
      h.versioning.publishDraft({
        draftId: c.id,
        effectiveAt: '2026-02-01T00:00:00.000Z',
        idempotencyKey: 'c',
      }),
    (err) => err.code === 'OVERLAPPING_EFFECTIVE_WINDOW',
  );

  // rejected drafts remain drafts and publishable later with a valid time
  const retry = h.versioning.publishDraft({
    draftId: c.id,
    effectiveAt: '2026-04-01T00:00:00.000Z',
    idempotencyKey: 'c',
  });
  assert.equal(retry.version.version_no, 3);

  const events = h.db
    .prepare(`SELECT event_type FROM audit_events WHERE event_type='publish_rejected'`)
    .all();
  assert.ok(events.length >= 2);
  h.close();
});

test('publishing the same draft twice without the idempotency key is rejected', () => {
  const h = createTestHarness();
  const d = h.versioning.createDraft({ matrix: V2_MATRIX });
  h.versioning.publishDraft({
    draftId: d.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'k',
  });
  assert.throws(
    () =>
      h.versioning.publishDraft({
        draftId: d.id,
        effectiveAt: '2026-04-01T00:00:00.000Z',
        idempotencyKey: 'different',
      }),
    (err) => err.code === 'DRAFT_ALREADY_PUBLISHED',
  );
  h.close();
});

test('idempotent publish retry returns the identical version and never double-publishes', () => {
  const h = createTestHarness();
  const d = h.versioning.createDraft({ matrix: V2_MATRIX });
  const first = h.versioning.publishDraft({
    draftId: d.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'retry-me',
  });
  const second = h.versioning.publishDraft({
    draftId: d.id,
    effectiveAt: '2026-03-01T00:00:00.000Z',
    idempotencyKey: 'retry-me',
  });
  assert.equal(first.idempotent_replay, false);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.version.id, first.version.id);
  assert.equal(second.version.version_no, first.version.version_no);
  assert.equal(h.versioning.listVersions().length, 2); // v1 + v2 only
  h.close();
});

test('invalid matrix documents are rejected before persisting a draft', () => {
  const h = createTestHarness();
  assert.throws(
    () => h.versioning.createDraft({ matrix: { rules: [{ resource: 'x', job_types: ['only-one'] }] } }),
  );
  assert.throws(
    () =>
      h.versioning.createDraft({
        matrix: {
          rules: [
            { resource: 'x', job_types: ['a', 'b'] },
            { resource: 'x', job_types: ['b', 'a'] },
          ],
        },
      }),
    /duplicate rule/,
  );
  h.close();
});
