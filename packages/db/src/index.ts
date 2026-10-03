/**
 * PostgreSQL access for api and worker (ADR-0002).
 *
 * Connection setup comes from POSTGRES_* variables (docker compose) or a
 * single DATABASE_URL (CI, local development).
 */
import pg from 'pg'

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

export function createPool(): pg.Pool {
  if (process.env.DATABASE_URL) {
    return new pg.Pool({ connectionString: process.env.DATABASE_URL })
  }
  return new pg.Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  })
}
