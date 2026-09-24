/**
 * Concurrency test worker.
 * Usage: node test/publish-worker.mjs <dbPath> <draftId> <effectiveAt> <idempotencyKey>
 * Opens its OWN connection to the shared database file and attempts one publish.
 * Prints one JSON line to stdout.
 */
import { createClock } from '../src/domain/clock.mjs';
import { openDb } from '../src/db/index.mjs';
import { createServices } from '../src/db/services.mjs';

const [, , dbPath, draftId, effectiveAt, idempotencyKey] = process.argv;

const db = openDb(dbPath);
const services = createServices({ db, clock: createClock(() => effectiveAt) });
try {
  const result = services.versioning.publishDraft({
    draftId: Number(draftId),
    effectiveAt,
    idempotencyKey,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      version_no: result.version.version_no,
      effective_at: result.version.effective_at,
      idempotent_replay: result.idempotent_replay,
    }) + '\n',
  );
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: err.code, message: err.message }) + '\n');
} finally {
  db.close();
}
