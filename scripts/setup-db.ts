import { Client } from 'pg';
import dotenv from 'dotenv';
import { runMigrations } from './migrate';

dotenv.config();

async function setup() {
  const adminUrl = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/\/[^/]+$/, '/postgres')
    : 'postgresql://postgres:postgres@localhost:5432/postgres';

  console.log(`Connecting to admin DB at ${adminUrl.replace(/:[^:@]+@/, ':****@')}...`);
  const client = new Client({ connectionString: adminUrl });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL server.');

    // Check & create main DB
    const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'digital_wallet'");
    if (res.rowCount === 0) {
      await client.query('CREATE DATABASE digital_wallet');
      console.log('Database "digital_wallet" created.');
    } else {
      console.log('Database "digital_wallet" already exists.');
    }

    // Check & create test DB
    const testRes = await client.query("SELECT 1 FROM pg_database WHERE datname = 'digital_wallet_test'");
    if (testRes.rowCount === 0) {
      await client.query('CREATE DATABASE digital_wallet_test');
      console.log('Database "digital_wallet_test" created.');
    } else {
      console.log('Database "digital_wallet_test" already exists.');
    }
  } catch (err) {
    console.error('Failed setting up databases:', err);
    throw err;
  } finally {
    await client.end();
  }

  // Run migrations on both databases
  console.log('\n--- Migrating digital_wallet ---');
  await runMigrations(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/digital_wallet');

  console.log('\n--- Migrating digital_wallet_test ---');
  await runMigrations(process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/digital_wallet_test');

  console.log('\nDatabase setup and migrations finished successfully!');
}

setup().catch((err) => {
  console.error(err);
  process.exit(1);
});
