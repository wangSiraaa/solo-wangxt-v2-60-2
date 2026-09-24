import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.mjs';
import { createClock } from '../src/domain/clock.mjs';
import { createServices } from '../src/db/services.mjs';
import { createApp } from '../src/http/app.mjs';
import { LEGACY_DDL } from '../src/db/legacy.mjs';

/** Fresh temp-file database (file-backed so separate connections see WAL data). */
export function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'mutex-matrix-'));
  return join(dir, 'matrix.db');
}

export function createTestHarness({ path, now } = {}) {
  const dbPath = path ?? tempDbPath();
  let currentNow = now ?? '2026-01-15T10:00:00.000Z';
  const clock = createClock(() => currentNow);
  const db = openDb(dbPath);
  const services = createServices({ db, clock });
  const app = createApp(services);
  return {
    ...services,
    dbPath,
    app,
    setNow: (iso) => {
      currentNow = iso;
    },
    close: () => db.close(),
  };
}

/** Open a SECOND connection to the same file (concurrent publishers test). */
export function createSecondConnection(dbPath, clock) {
  const db = openDb(dbPath);
  return createServices({ db, clock });
}

/**
 * Simulate an OLD database: create legacy tables/data BEFORE the versioning
 * migrations run, then return the path for normal openDb() to migrate safely.
 */
export function prepareLegacyDatabase(dbPath, { pairs = [], plans = [] } = {}) {
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.exec(LEGACY_DDL);
  const insertPair = raw.prepare(
    `INSERT INTO legacy_mutex_matrix (resource, job_type_a, job_type_b) VALUES (?, ?, ?)`,
  );
  for (const p of pairs) insertPair.run(p.resource, p.job_type_a, p.job_type_b);
  const insertPlan = raw.prepare(
    `INSERT INTO legacy_job_plans (id, job_type, resource, planned_start_at, planned_end_at, status, conflict_note)
     VALUES (@id, @job_type, @resource, @planned_start_at, @planned_end_at, @status, @conflict_note)`,
  );
  for (const p of plans) {
    insertPlan.run({
      conflict_note: null,
      ...p,
    });
  }
  raw.close();
  return dbPath;
}
