import { createHash } from 'node:crypto';

/**
 * Matrix document model
 * ---------------------
 * A matrix is a set of mutual-exclusion rules over (job_type, resource).
 *
 *   {
 *     "schema_version": 1,
 *     "rules": [
 *       { "resource": "crane-a", "job_types": ["lift", "paint"], "mode": "mutex" },
 *       { "resource": "*",      "job_types": ["weld", "paint"], "mode": "mutex" }
 *     ]
 *   }
 *
 * A rule with resource "*" applies to every resource. All rules are mutex
 * (two jobs of any two distinct listed job-types may not overlap in time on
 * the same resource).
 */

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.status = 400;
    this.details = details;
  }
}

/** Validate and normalize a matrix document. Returns the normalized object. */
export function normalizeMatrix(content) {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new ValidationError('matrix must be an object');
  }
  const schemaVersion = content.schema_version ?? 1;
  if (schemaVersion !== 1) {
    throw new ValidationError(`unsupported schema_version: ${schemaVersion}`);
  }
  if (!Array.isArray(content.rules)) {
    throw new ValidationError('matrix.rules must be an array');
  }
  const rules = content.rules.map((raw, i) => normalizeRule(raw, i));

  // Reject exact duplicate rules so two drafts cannot silently collapse.
  const seen = new Set();
  for (const r of rules) {
    const key = `${r.resource}|${r.job_types.join(',')}`;
    if (seen.has(key)) {
      throw new ValidationError(`duplicate rule detected`, { rule: r });
    }
    seen.add(key);
  }

  return { schema_version: 1, rules };
}

function normalizeRule(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`rules[${index}] must be an object`);
  }
  const resource = raw.resource;
  if (typeof resource !== 'string' || resource.trim() === '') {
    throw new ValidationError(`rules[${index}].resource must be a non-empty string`);
  }
  if (!Array.isArray(raw.job_types) || raw.job_types.length < 2) {
    throw new ValidationError(
      `rules[${index}].job_types must be an array of at least 2 job types`,
    );
  }
  const jobTypes = raw.job_types.map((jt) => {
    if (typeof jt !== 'string' || jt.trim() === '') {
      throw new ValidationError(`rules[${index}].job_types entries must be non-empty strings`);
    }
    return jt;
  });
  // Normalize ordering, reject duplicates within a rule.
  const sorted = [...new Set(jobTypes)].sort();
  if (sorted.length !== jobTypes.length) {
    throw new ValidationError(`rules[${index}] contains duplicate job types`);
  }
  const mode = raw.mode ?? 'mutex';
  if (mode !== 'mutex') {
    throw new ValidationError(`rules[${index}].mode must be "mutex"`);
  }
  return { resource, job_types: sorted, mode };
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * insignificant whitespace. Two drafts with the same logical matrix produce
 * the same bytes and therefore the same hash.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function matrixHash(normalizedContent) {
  return createHash('sha256').update(canonicalize(normalizedContent)).digest('hex');
}

/**
 * Expand a matrix document into conflict pairs keyed by resource:
 *   Map<resource, Set<"jobTypeA|jobTypeB">>
 * Wildcard resource "*" is expanded at evaluation time.
 */
export function buildConflictIndex(matrix) {
  const byResource = new Map();
  matrix.rules.forEach((rule, ruleIndex) => {
    if (!byResource.has(rule.resource)) byResource.set(rule.resource, []);
    const pairs = [];
    for (let i = 0; i < rule.job_types.length; i += 1) {
      for (let j = i + 1; j < rule.job_types.length; j += 1) {
        pairs.push([rule.job_types[i], rule.job_types[j]]);
      }
    }
    byResource.get(rule.resource).push({ pairs, ruleIndex });
  });
  return byResource;
}

function unorderedPairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Return the rule basis that makes `candidate` conflict with `other` on a
 * resource, or null. A basis entry names the rule index and the two job types.
 */
export function findConflictRule(conflictIndex, resource, candidateType, otherType) {
  const buckets = [];
  if (conflictIndex.has(resource)) buckets.push(...conflictIndex.get(resource));
  if (resource !== '*' && conflictIndex.has('*')) buckets.push(...conflictIndex.get('*'));
  const pairKey = unorderedPairKey(candidateType, otherType);
  for (const bucket of buckets) {
    for (const [a, b] of bucket.pairs) {
      if (unorderedPairKey(a, b) === pairKey) {
        return { rule_index: bucket.ruleIndex, resource, job_types: [a, b], mode: 'mutex' };
      }
    }
  }
  return null;
}
