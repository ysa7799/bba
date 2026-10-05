import { pingDatabase, type DatabaseHandle } from '@businessos/database';
import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';

/** Minimal HTTP health endpoint for container orchestration. */
export function startHealthServer(port: number, db: DatabaseHandle, redis: Redis): Server {
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    void Promise.all([
      pingDatabase(db.pool),
      redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]).then(([database, queue]) => {
      const ok = database && queue;
      response
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: ok ? 'ok' : 'unavailable', checks: { database, queue } }));
    });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
