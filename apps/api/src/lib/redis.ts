import { Redis } from 'ioredis';

export function createRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
}

export async function pingRedis(redis: Redis, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('redis ping timed out'));
        }, timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
