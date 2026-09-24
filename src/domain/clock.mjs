/** Injectable UTC clock. Tests override `now` to cross effective boundaries. */
export function createClock(getNow) {
  return { now: () => (getNow ? getNow() : new Date().toISOString()) };
}

export function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    const err = new Error(`invalid ISO timestamp: ${value}`);
    err.code = 'VALIDATION_ERROR';
    err.status = 400;
    throw err;
  }
  return new Date(ms).toISOString();
}
