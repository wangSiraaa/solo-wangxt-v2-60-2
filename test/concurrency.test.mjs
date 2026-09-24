import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, 'publish-worker.mjs');

const V2_MATRIX = {
  rules: [
    { resource: 'crane-a', job_types: ['lift', 'paint'] },
    { resource: 'oven-1', job_types: ['cure', 'weld'] },
    { resource: '*', job_types: ['lift', 'weld'] },
  ],
};

function runWorker(dbPath, draftId, effectiveAt, key) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, dbPath, String(draftId), effectiveAt, key], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ ok: false, code: 'WORKER_ERROR', message: err || out });
      }
    });
  });
}

test('concurrent publish with the SAME idempotency key: exactly one publish, retries replay', async () => {
  const h = createTestHarness();
  const draft = h.versioning.createDraft({ matrix: V2_MATRIX });
  h.close(); // workers own the file

  const at = '2026-03-01T00:00:00.000Z';
  const results = await Promise.all(
    Array.from({ length: 6 }, () => runWorker(h.dbPath, draft.id, at, 'same-key-xyz')),
  );

  const successes = results.filter((r) => r.ok && !r.idempotent_replay);
  const replays = results.filter((r) => r.ok && r.idempotent_replay);
  const errors = results.filter((r) => !r.ok);

  assert.equal(successes.length, 1, JSON.stringify(results));
  assert.equal(replays.length, 5, JSON.stringify(results));
  assert.equal(errors.length, 0, JSON.stringify(results));
  assert.ok(results.every((r) => r.version_no === 2));

  const check = createTestHarness({ path: h.dbPath });
  assert.equal(check.versioning.listVersions().length, 2);
  check.close();
});

test('concurrent publish of DIFFERENT drafts at the SAME effective time: only one wins', async () => {
  const h = createTestHarness();
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(h.versioning.createDraft({ matrix: V2_MATRIX }).id);
  }
  h.close();

  const at = '2026-05-01T00:00:00.000Z';
  const results = await Promise.all(
    ids.map((id, i) => runWorker(h.dbPath, id, at, `distinct-key-${i}`)),
  );

  const successes = results.filter((r) => r.ok && !r.idempotent_replay);
  const rejected = results.filter((r) => !r.ok);

  assert.equal(successes.length, 1, JSON.stringify(results, null, 2));
  assert.equal(rejected.length, 4, JSON.stringify(results, null, 2));
  assert.ok(
    rejected.every((r) => r.code === 'OVERLAPPING_EFFECTIVE_WINDOW' || r.code === 'SQLITE_CONSTRAINT_UNIQUE'),
    JSON.stringify(rejected),
  );

  const check = createTestHarness({ path: h.dbPath });
  const versions = check.versioning.listVersions();
  assert.equal(versions.length, 2); // v1 + one winner
  assert.equal(versions[1].effective_at, at);
  // losers stay drafts
  assert.equal(check.versioning.listDrafts().length, 4);
  check.close();
});

test('sequential publishes at distinct future times all succeed and chain correctly', async () => {
  const h = createTestHarness();
  const times = [
    '2026-03-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
  ];
  for (let i = 0; i < 3; i += 1) {
    const id = h.versioning.createDraft({ matrix: V2_MATRIX }).id;
    const r = h.versioning.publishDraft({ draftId: id, effectiveAt: times[i], idempotencyKey: `chain-key-${i}` });
    assert.equal(r.version.version_no, i + 2);
  }
  assert.deepEqual(
    h.versioning.listVersions().map((v) => v.effective_at),
    ['1970-01-01T00:00:00.000Z', ...times],
  );
  h.close();
});

test('concurrent publish at DISTINCT future times: the committed chain is always a valid partition and losers get a clear rejection', async () => {
  // With strictly monotonic, append-only cutovers the IMMEDIATE write lock
  // serializes transactions, so which of the racing cutovers win depends on
  // commit order (an ascending-time commit order legitimately chains them, a
  // descending one rejects the rest as overlap). What is invariant and tested
  // here: every response is deterministic, every rejection names the overlap
  // code, and the surviving windows are ALWAYS a gapless half-open partition.
  const h = createTestHarness();
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(h.versioning.createDraft({ matrix: V2_MATRIX }).id);
  }
  h.close();

  const times = [
    '2026-03-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
    '2026-12-01T00:00:00.000Z',
  ];
  const results = await Promise.all(
    ids.map((id, i) => runWorker(h.dbPath, id, times[i], `future-key-${i}`)),
  );

  const winners = results.filter((r) => r.ok && !r.idempotent_replay);
  const rejected = results.filter((r) => !r.ok);
  assert.ok(winners.length >= 1, JSON.stringify(results));
  assert.equal(winners.length + rejected.length, 4);
  assert.ok(
    rejected.every((r) => r.code === 'OVERLAPPING_EFFECTIVE_WINDOW'),
    JSON.stringify(rejected),
  );

  const check = createTestHarness({ path: h.dbPath });
  const versions = check.versioning.listVersions();
  // window chain: v1@epoch, strictly increasing boundaries, half-open joins
  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(
      Date.parse(versions[i].effective_at) > Date.parse(versions[i - 1].effective_at),
      'boundaries strictly increase',
    );
    assert.equal(versions[i].effective_at, versions[i - 1].superseded_at, 'windows join exactly');
  }
  assert.equal(versions[versions.length - 1].superseded_at, null, 'last window open');
  // each winner's time appears exactly once as a boundary
  const boundaries = new Set(versions.map((v) => v.effective_at));
  for (const w of winners) assert.ok(boundaries.has(w.effective_at));
  // rejected drafts remain drafts; winning drafts became versions
  assert.equal(check.versioning.listDrafts().length, rejected.length);
  check.close();
});
