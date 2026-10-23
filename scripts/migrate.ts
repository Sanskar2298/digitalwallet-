import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export async function runMigrations(connectionString?: string): Promise<void> {
  const dbUrl = connectionString || process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/digital_wallet';
  const pool = new Pool({ connectionString: dbUrl });

  const client: PoolClient = await pool.connect();
  try {
    console.log(`[Migrations] Connected to database: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`);

    // Create migrations tracker table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        'SELECT id FROM schema_migrations WHERE filename = $1',
        [file]
      );

      if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
        console.log(`[Migrations] Skipping already applied: ${file}`);
        continue;
      }

      console.log(`[Migrations] Applying: ${file}...`);
      const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[Migrations] Successfully applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Migrations] Failed applying ${file}:`, err);
        throw err;
      }
    }

    console.log('[Migrations] All migrations completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Migrations] Migration failed:', err);
      process.exit(1);
    });
}
