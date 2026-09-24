// Generates src/http/openapi.json deterministically. Run: node tools/gen-openapi.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const jsonError = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'OVERLAPPING_EFFECTIVE_WINDOW' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

const rule = {
  type: 'object',
  required: ['resource', 'job_types'],
  properties: {
    resource: { type: 'string', description: "Resource name, or '*' for a rule matching every resource.", example: 'crane-a' },
    job_types: { type: 'array', minItems: 2, items: { type: 'string' }, example: ['lift', 'paint'] },
    mode: { type: 'string', enum: ['mutex'], default: 'mutex' },
  },
};
const matrix = {
  type: 'object',
  required: ['rules'],
  properties: {
    schema_version: { type: 'integer', enum: [1], default: 1 },
    rules: { type: 'array', items: { $ref: '#/components/schemas/MatrixRule' } },
  },
};
const version = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    version_no: { type: ['integer', 'null'], description: 'Null while draft; assigned at publish.' },
    status: { type: 'string', enum: ['draft', 'published'] },
    description: { type: ['string', 'null'] },
    matrix: { $ref: '#/components/schemas/Matrix' },
    matrix_hash: { type: 'string', description: 'sha256 hex of the canonical matrix JSON.' },
    effective_at: { type: ['string', 'null'], format: 'date-time' },
    superseded_at: { type: ['string', 'null'], format: 'date-time', description: 'Null for the version currently in force.' },
    created_at: { type: 'string', format: 'date-time' },
    published_at: { type: ['string', 'null'], format: 'date-time' },
  },
};
const basis = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    job_type: { type: 'string' },
    rule: {
      type: 'object',
      properties: {
        rule_index: { type: 'integer' },
        resource: { type: 'string' },
        job_types: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['mutex'] },
      },
    },
  },
};
const decision = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    decision_kind: { type: 'string', enum: ['scheduled', 'start_confirmed', 'conflict'] },
    job_id: { type: 'string' },
    job_type: { type: 'string' },
    resource: { type: 'string' },
    planned_start_at: { type: 'string', format: 'date-time' },
    planned_end_at: { type: 'string', format: 'date-time' },
    decided_at: { type: 'string', format: 'date-time' },
    matrix_version_id: { type: 'integer' },
    matrix_version_no: { type: 'integer' },
    matrix_hash: { type: 'string' },
    matrix_snapshot: { $ref: '#/components/schemas/Matrix' },
    conflict_basis: { type: 'array', items: { $ref: '#/components/schemas/ConflictBasis' } },
    conflicting_job_id: { type: ['string', 'null'] },
    request_idempotency_key: { type: ['string', 'null'] },
  },
};
const replay = {
  type: 'object',
  properties: {
    recorded: { $ref: '#/components/schemas/PlanDecision' },
    replay: {
      type: 'object',
      properties: {
        matrix_version_no: { type: 'integer' },
        stored_hash: { type: 'string' },
        recomputed_hash: { type: 'string' },
        hash_match: { type: 'boolean' },
        basis: { type: 'array', items: { $ref: '#/components/schemas/ConflictBasis' } },
        conflicting_job_id: { type: ['string', 'null'] },
        basis_matches_record: { type: 'boolean' },
        receipt_preserved: { type: 'boolean' },
        replay_matches: { type: 'boolean' },
      },
    },
  },
};

const err = (desc) => ({ description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const json200 = (desc, schema) => ({ description: desc, content: { 'application/json': { schema } } });

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Mutual-Exclusion Job Matrix API',
    version: '1.0.0',
    description:
      'Versioned mutex job matrix: drafts, publish with effective time, immutable decision snapshots, and historical replay. Published matrix versions form disjoint half-open effective windows [effective_at, superseded_at); every planning decision freezes the version and conflict basis it was judged against.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Drafts' },
    { name: 'Versions' },
    { name: 'Plans' },
    { name: 'Audit' },
  ],
  components: {
    schemas: {
      MatrixRule: rule,
      Matrix: matrix,
      MatrixVersion: version,
      ConflictBasis: basis,
      PlanDecision: decision,
      PlanReplay: replay,
      Error: jsonError,
    },
  },
  paths: {
    '/health': {
      get: { summary: 'Liveness and current server time', responses: { 200: { description: 'OK' } } },
    },
    '/openapi.json': {
      get: { summary: 'This OpenAPI document', responses: { 200: { description: 'OK' } } },
    },
    '/v1/matrix/drafts': {
      get: {
        tags: ['Drafts'],
        summary: 'List drafts',
        responses: {
          200: json200('Drafts', {
            type: 'object',
            properties: { drafts: { type: 'array', items: { $ref: '#/components/schemas/MatrixVersion' } } },
          }),
        },
      },
      post: {
        tags: ['Drafts'],
        summary: 'Create a draft matrix',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['matrix'],
                properties: {
                  description: { type: 'string' },
                  matrix: { $ref: '#/components/schemas/Matrix' },
                },
              },
            },
          },
        },
        responses: {
          201: json200('Draft created', { $ref: '#/components/schemas/MatrixVersion' }),
          400: err('Invalid matrix'),
        },
      },
    },
    '/v1/matrix/drafts/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        tags: ['Drafts'],
        summary: 'Get a draft',
        responses: {
          200: json200('Draft', { $ref: '#/components/schemas/MatrixVersion' }),
          404: err('Not found'),
        },
      },
      put: {
        tags: ['Drafts'],
        summary: "Replace a draft's matrix",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['matrix'],
                properties: {
                  description: { type: 'string' },
                  matrix: { $ref: '#/components/schemas/Matrix' },
                },
              },
            },
          },
        },
        responses: {
          200: json200('Updated draft', { $ref: '#/components/schemas/MatrixVersion' }),
          404: err('Not found'),
          409: err('Already published'),
        },
      },
    },
    '/v1/matrix/drafts/{id}/publish': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      post: {
        tags: ['Drafts'],
        summary: 'Publish a draft at an effective time',
        description:
          'Assigns the next version number and opens effective window [effective_at, infinity), closing the previous open window. Overlapping windows are rejected (409 OVERLAPPING_EFFECTIVE_WINDOW). Retrying with the same idempotency_key returns the already-published version (200).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['idempotency_key'],
                properties: {
                  effective_at: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Defaults to current server time. Must be strictly later than the newest published effective_at.',
                  },
                  idempotency_key: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: json200('Published', {
            allOf: [{ $ref: '#/components/schemas/MatrixVersion' }],
          }),
          200: json200('Idempotent replay of an earlier publish', { $ref: '#/components/schemas/MatrixVersion' }),
          400: err('Validation error (e.g. missing idempotency_key)'),
          409: err('Overlapping effective window, duplicate publish, or already published'),
        },
      },
    },
    '/v1/matrix/versions': {
      get: {
        tags: ['Versions'],
        summary: 'List published versions with effective windows',
        responses: {
          200: json200('Versions', {
            type: 'object',
            properties: { versions: { type: 'array', items: { $ref: '#/components/schemas/MatrixVersion' } } },
          }),
        },
      },
    },
    '/v1/matrix/versions/current': {
      get: {
        tags: ['Versions'],
        summary: 'Version in force now',
        responses: {
          200: json200('Current version', { $ref: '#/components/schemas/MatrixVersion' }),
        },
      },
    },
    '/v1/matrix/versions/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Numeric row id or version_no.' }],
      get: {
        tags: ['Versions'],
        summary: 'Get a published version (historical snapshot)',
        responses: {
          200: json200('Version', { $ref: '#/components/schemas/MatrixVersion' }),
          404: err('Not found'),
        },
      },
    },
    '/v1/plans': {
      get: {
        tags: ['Plans'],
        summary: 'List decisions (frozen plans/conflicts/receipts)',
        parameters: [
          { name: 'job_id', in: 'query', schema: { type: 'string' } },
          { name: 'resource', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: {
          200: json200('Decisions', {
            type: 'object',
            properties: { decisions: { type: 'array', items: { $ref: '#/components/schemas/PlanDecision' } } },
          }),
        },
      },
      post: {
        tags: ['Plans'],
        summary: 'Schedule or start a job',
        description:
          'Resolves the matrix version in force at planned_start_at, evaluates conflicts with only that version, and appends an immutable decision carrying the full matrix snapshot and conflict basis. Conflicting submissions are recorded as outcome=conflict (HTTP 409). Same idempotency_key replays the original decision (HTTP 200).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['job_id', 'job_type', 'resource'],
                properties: {
                  job_id: { type: 'string' },
                  job_type: { type: 'string' },
                  resource: { type: 'string' },
                  planned_start_at: { type: 'string', format: 'date-time', description: 'Defaults to now; also selects the matrix version in force (cross-boundary).' },
                  planned_end_at: { type: 'string', format: 'date-time', description: 'Defaults to start + 60 minutes.' },
                  decision_kind: { type: 'string', enum: ['scheduled', 'start_confirmed'], default: 'scheduled' },
                  idempotency_key: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: json200('Accepted (scheduled/start_confirmed)', { $ref: '#/components/schemas/PlanDecision' }),
          200: json200('Idempotent replay', { $ref: '#/components/schemas/PlanDecision' }),
          409: json200('Conflict (decision still recorded) or duplicate job_id', { $ref: '#/components/schemas/PlanDecision' }),
          400: err('Invalid plan'),
        },
      },
    },
    '/v1/plans/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Decision id or job_id.' }],
      get: {
        tags: ['Plans'],
        summary: 'Get a frozen decision receipt',
        responses: {
          200: json200('Decision', { $ref: '#/components/schemas/PlanDecision' }),
          404: err('Not found'),
        },
      },
    },
    '/v1/plans/{id}/replay': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Decision id or job_id.' }],
      get: {
        tags: ['Plans'],
        summary: 'Replay a historical decision against its frozen snapshot',
        description:
          'Recomputes the conflict basis from the matrix_snapshot stored on the decision, verifies its sha256, and reports whether the historical conclusion reproduces. Works identically after restart since everything needed is persisted.',
        responses: {
          200: json200('Replay result', { $ref: '#/components/schemas/PlanReplay' }),
          404: err('Not found'),
        },
      },
    },
    '/v1/audit/events': {
      get: {
        tags: ['Audit'],
        summary: 'Query audit events (draft lifecycle, publish, decisions)',
        parameters: [
          { name: 'aggregate', in: 'query', schema: { type: 'string', enum: ['matrix_version', 'plan_decision'] } },
          { name: 'aggregate_id', in: 'query', schema: { type: 'string' } },
          { name: 'event_type', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: {
          200: json200('Audit events', {
            type: 'object',
            properties: {
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    event_type: { type: 'string' },
                    aggregate: { type: 'string' },
                    aggregate_id: { type: ['string', 'null'] },
                    payload: { type: 'object' },
                    occurred_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          }),
        },
      },
    },
  },
};

writeFileSync(join(here, '..', 'src', 'http', 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
console.log('wrote src/http/openapi.json');
