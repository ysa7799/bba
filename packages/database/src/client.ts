import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseOptions {
  url: string;
  /** Max pool size per process. */
  maxConnections?: number;
  applicationName?: string;
  /** Per-statement timeout in ms; protects the pool from runaway queries. */
  statementTimeoutMs?: number;
}

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

// Return int8 (bigint) columns as strings at the driver level; Drizzle's `bigint({ mode: 'bigint' })`
// columns convert them to JS bigint. Never let money silently become a float.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'businessos',
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/** Lightweight readiness probe. */
export async function pingDatabase(pool: pg.Pool, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      pool.query('select 1 as ok'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('database ping timed out'));
        }, timeoutMs);
      }),
    ]);
    return result.rows.length === 1;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
