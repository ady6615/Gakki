import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createLogger } from '../utils/logger';
import * as schema from './schema';

const logger = createLogger('database');

export type DatabaseClient = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: DatabaseClient | null = null;

/**
 * Connect to the PostgreSQL database.
 *
 * Creates a connection pool and wraps it with Drizzle ORM for
 * type-safe queries. Verifies the connection with a test query
 * before returning.
 *
 * @param connectionString - PostgreSQL connection URL
 * @returns Drizzle database client
 * @throws If the database is unreachable
 */
export async function connectDatabase(connectionString: string): Promise<DatabaseClient> {
  if (db) return db;

  logger.info('Connecting to PostgreSQL...');

  pool = new pg.Pool({
    connectionString,
    max: 10,
  });

  // Verify the connection actually works
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    logger.info('PostgreSQL connection verified');
  } finally {
    client.release();
  }

  db = drizzle(pool, { schema });
  return db;
}

/**
 * Get the existing database client.
 * @throws If connectDatabase() has not been called
 */
export function getDatabase(): DatabaseClient {
  if (!db) {
    throw new Error('Database not initialized. Call connectDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection pool gracefully.
 */
export async function disconnectDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    logger.info('PostgreSQL connection closed');
  }
}
