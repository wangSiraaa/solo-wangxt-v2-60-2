import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { LEGACY_MATRIX, seedLegacyV1, hasLegacyTables } from './legacy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

/**
 * Open the database and run every pending migration inside a single
 * transaction per migration (DDL is transactional in SQLite, which makes
 * upgrades atomic and crash-safe).
 */
export function openDb(filename) {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(readFileSync(join(MIGRATIONS_DIR, '001_migration_ledger.sql'), 'utf8'));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (file === '001_migration_ledger.sql') continue;
    applyOnce(db, file, () => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    });
  }

  // JS migration: safe import of legacy matrix/plans data.
  applyOnce(db, '003_legacy_safe_migration', () => {
    seedLegacyV1(db);
  });

  return db;
}

function applyOnce(db, name, fn) {
  const already = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name);
  if (already) return;
  const tx = db.transaction(() => {
    fn();
    db.prepare('INSERT INTO migrations(name, applied_at) VALUES (?, ?)').run(
      name,
      new Date().toISOString(),
    );
  });
  tx();
}

/** Run a function inside an IMMEDIATE transaction (acquires the write lock up
 * front so concurrent publishers serialize rather than deadlock-retry). */
export function withWriteTransaction(db, fn) {
  const tx = db.transaction(fn);
  return tx.immediate();
}

export { LEGACY_MATRIX, hasLegacyTables };
