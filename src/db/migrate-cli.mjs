#!/usr/bin/env node
import { openDb } from './index.mjs';

const path = process.env.MATRIX_DB_PATH ?? './data/matrix.db';
const db = openDb(path);
const versions = db.prepare(`SELECT version_no, status, effective_at, superseded_at FROM matrix_versions ORDER BY version_no`).all();
// eslint-disable-next-line no-console
console.log(`migrated ${path}`);
for (const v of versions) {
  // eslint-disable-next-line no-console
  console.log(`  v${v.version_no} ${v.status} [${v.effective_at} -> ${v.superseded_at ?? 'now'})`);
}
db.close();
