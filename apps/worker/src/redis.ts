import { Redis } from 'ioredis';

/** BullMQ workers require `maxRetriesPerRequest: null` (blocking commands must not time out). */
export function createWorkerRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}
