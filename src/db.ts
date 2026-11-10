import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config.ts";

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting), and numbers as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export type Db = Pick<PoolClient, "query">;

export async function q<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}

export async function one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
