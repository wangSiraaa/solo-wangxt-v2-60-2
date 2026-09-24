import { createClock } from '../domain/clock.mjs';
import { openDb } from './index.mjs';
import { createVersioningService } from './versioning.mjs';
import { createPlanningService } from './planning.mjs';
import { createAuditService } from './audit.mjs';

/** Wire DB + domain services. Allows clock/db injection for tests. */
export function createServices({ db, clock } = {}) {
  const resolvedDb = db ?? openDb(process.env.MATRIX_DB_PATH ?? './data/matrix.db');
  const resolvedClock = clock ?? createClock();
  const versioning = createVersioningService(resolvedDb, resolvedClock);
  const planning = createPlanningService(resolvedDb, versioning, resolvedClock);
  const audit = createAuditService(resolvedDb);
  return { db: resolvedDb, clock: resolvedClock, versioning, planning, audit };
}
