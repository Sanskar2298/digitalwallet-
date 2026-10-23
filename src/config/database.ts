import { Pool, PoolClient } from 'pg';
import { env } from './env';
import { logger } from '../utils/logger';

export const pool = new Pool({
  connectionString: env.NODE_ENV === 'test' ? env.TEST_DATABASE_URL : env.DATABASE_URL,
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
});

/**
 * Execute a unit of work inside a single PostgreSQL transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health check helper for PostgreSQL
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT 1 as alive');
    return res.rows[0]?.alive === 1;
  } catch (err) {
    logger.error({ err }, 'PostgreSQL health check failed');
    return false;
  }
}
