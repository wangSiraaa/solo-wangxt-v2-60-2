/** Read-only audit query service. Audit rows are append-only. */
export function createAuditService(db) {
  function listEvents({ aggregate, aggregate_id, event_type, limit = 100 } = {}) {
    const clauses = [];
    const params = {};
    if (aggregate) {
      clauses.push('aggregate = @aggregate');
      params.aggregate = aggregate;
    }
    if (aggregate_id !== undefined) {
      clauses.push('aggregate_id = @aggregate_id');
      params.aggregate_id = String(aggregate_id);
    }
    if (event_type) {
      clauses.push('event_type = @event_type');
      params.event_type = event_type;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.limit = Math.min(Number(limit) || 100, 500);
    return db
      .prepare(
        `SELECT id, event_type, aggregate, aggregate_id, payload, occurred_at
           FROM audit_events ${where} ORDER BY id DESC LIMIT @limit`,
      )
      .all(params)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  return { listEvents };
}
