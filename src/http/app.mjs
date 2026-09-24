import express from 'express';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '../domain/matrix.mjs';
import { VersioningError } from '../db/versioning.mjs';
import { PlanningError } from '../db/planning.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const openapiSpec = JSON.parse(readFileSync(join(here, 'openapi.json'), 'utf8'));

const ruleSchema = z.object({
  resource: z.string().min(1),
  job_types: z.array(z.string().min(1)).min(2),
  mode: z.literal('mutex').default('mutex'),
});
const matrixSchema = z.object({
  schema_version: z.literal(1).optional(),
  rules: z.array(ruleSchema),
});

const draftCreateSchema = z.object({
  description: z.string().optional(),
  matrix: matrixSchema,
});
const draftUpdateSchema = draftCreateSchema;

const publishSchema = z.object({
  effective_at: z.string().datetime().optional(),
  idempotency_key: z.string().min(1),
});

const planSchema = z.object({
  job_id: z.string().min(1),
  job_type: z.string().min(1),
  resource: z.string().min(1),
  planned_start_at: z.string().datetime().optional(),
  planned_end_at: z.string().datetime().optional(),
  decision_kind: z.enum(['scheduled', 'start_confirmed']).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export function createApp({ versioning, planning, audit, clock }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', now: clock.now() }));

  // ---- OpenAPI ---------------------------------------------------------------
  app.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  app.get('/docs', (_req, res) =>
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Mutex Matrix API</title>
       <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
       <body><div id="ui"></div>
       <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
       <script>window.onload = () => SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui' });</script>
       </body></html>`,
    ),
  );

  // ---- Drafts ----------------------------------------------------------------
  app.post('/v1/matrix/drafts', (req, res, next) => {
    try {
      const body = draftCreateSchema.parse(req.body);
      res.status(201).json(versioning.createDraft(body));
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/matrix/drafts', (_req, res, next) => {
    try {
      res.json({ drafts: versioning.listDrafts() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/matrix/drafts/:id', (req, res, next) => {
    try {
      res.json(versioning.getDraft(Number(req.params.id)));
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/matrix/drafts/:id', (req, res, next) => {
    try {
      const body = draftUpdateSchema.parse(req.body);
      res.json(versioning.updateDraft(Number(req.params.id), body));
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/matrix/drafts/:id/publish', (req, res, next) => {
    try {
      const body = publishSchema.parse(req.body);
      const result = versioning.publishDraft({
        draftId: Number(req.params.id),
        effectiveAt: body.effective_at,
        idempotencyKey: body.idempotency_key,
      });
      // Idempotent replay returns 200; first publish returns 201.
      res.status(result.idempotent_replay ? 200 : 201).json({
        ...result.version,
        idempotent_replay: result.idempotent_replay,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Published versions ----------------------------------------------------
  app.get('/v1/matrix/versions', (_req, res, next) => {
    try {
      res.json({ versions: versioning.listVersions() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/matrix/versions/current', (_req, res, next) => {
    try {
      res.json(versioning.currentVersion());
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/matrix/versions/:id', (req, res, next) => {
    try {
      const id = Number.isNaN(Number(req.params.id)) ? req.params.id : Number(req.params.id);
      res.json(versioning.getVersion(id));
    } catch (err) {
      next(err);
    }
  });

  // ---- Plans / decisions -----------------------------------------------------
  app.post('/v1/plans', (req, res, next) => {
    try {
      const body = planSchema.parse(req.body);
      const { decision, idempotent_replay } = planning.submitPlan(body);
      const conflicting = decision.decision_kind === 'conflict';
      res.status(idempotent_replay ? 200 : conflicting ? 409 : 201).json({
        ...decision,
        idempotent_replay,
        outcome: conflicting ? 'conflict' : 'accepted',
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/plans', (req, res, next) => {
    try {
      res.json({
        decisions: planning.listDecisions({
          job_id: req.query.job_id,
          resource: req.query.resource,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/plans/:id', (req, res, next) => {
    try {
      res.json(planning.getDecision(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // Historical replay: frozen snapshot + hash + recomputed basis.
  app.get('/v1/plans/:id/replay', (req, res, next) => {
    try {
      res.json(planning.replayDecision(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // ---- Audit -----------------------------------------------------------------
  app.get('/v1/audit/events', (req, res, next) => {
    try {
      res.json({
        events: audit.listEvents({
          aggregate: req.query.aggregate,
          aggregate_id: req.query.aggregate_id,
          event_type: req.query.event_type,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Error handling --------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'request validation failed', details: err.issues },
      });
    }
    if (err instanceof ValidationError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err instanceof VersioningError || err instanceof PlanningError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  return app;
}
