#!/usr/bin/env node
import { createServices } from './db/services.mjs';
import { createApp } from './http/app.mjs';

const services = createServices();
const { db } = services;
const app = createApp(services);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`mutex-matrix API listening on http://localhost:${port}`);
  console.log(`OpenAPI docs: http://localhost:${port}/docs`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
