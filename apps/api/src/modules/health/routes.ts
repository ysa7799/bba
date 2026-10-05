import { pingDatabase } from '@businessos/database';
import type { FastifyInstance } from 'fastify';
import { pingRedis } from '../../lib/redis';

export function healthRoutes(app: FastifyInstance): void {
  app.get('/live', { config: { rateLimit: false } }, () => ({ status: 'ok' }));

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const [database, redis] = await Promise.all([
      pingDatabase(app.deps.db.pool),
      pingRedis(app.deps.redis),
    ]);
    const ready = database && redis;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      checks: { database: database ? 'ok' : 'fail', redis: redis ? 'ok' : 'fail' },
    });
  });
}
