/**
 * Process entry point: start the HTTP server on $PORT (Cloud Run sets it).
 */
import { createApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';
import { sessionPool } from './db/pool.js';

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`Stable listening on port ${config.PORT} (${config.NODE_ENV})`);
});

// Cloud Run sends SIGTERM before stopping a container: finish in-flight
// requests, then close database connections.
process.on('SIGTERM', () => {
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), sessionPool.end()]);
    process.exit(0);
  });
});
