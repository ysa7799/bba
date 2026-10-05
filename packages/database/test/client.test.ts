import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, pingDatabase } from '../src';
import { requireEnv } from '../src/testing';

const handle = createDatabase({ url: requireEnv('DATABASE_URL'), maxConnections: 2 });

afterAll(async () => {
  await handle.close();
});

describe('database client', () => {
  it('connects as the runtime role without RLS bypass', async () => {
    const result = await handle.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('answers readiness pings', async () => {
    await expect(pingDatabase(handle.pool)).resolves.toBe(true);
  });

  it('reports unhealthy for unreachable databases', async () => {
    const broken = createDatabase({
      url: 'postgres://nobody:nothing@127.0.0.1:1/none',
      maxConnections: 1,
    });
    await expect(pingDatabase(broken.pool, 500)).resolves.toBe(false);
    await broken.close();
  });
});
