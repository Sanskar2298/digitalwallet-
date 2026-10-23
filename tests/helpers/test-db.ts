import { Pool } from 'pg';
import { env } from '../../src/config/env';
import { buildApp } from '../../src/app';
import { FastifyInstance } from 'fastify';
import { runMigrations } from '../../scripts/migrate';

export const testPool = new Pool({
  connectionString: env.TEST_DATABASE_URL,
  max: 20,
});

let isMigrated = false;

export async function setupTestEnvironment(): Promise<FastifyInstance> {
  if (!isMigrated) {
    await runMigrations(env.TEST_DATABASE_URL);
    isMigrated = true;
  }

  const app = buildApp();
  await app.ready();
  return app;
}

export async function resetDatabase(): Promise<void> {
  const client = await testPool.connect();
  try {
    // Disable triggers temporarily to truncate tables with foreign key cascades
    await client.query(`
      TRUNCATE TABLE users, accounts, transfers, ledger_entries, outbox_events RESTART IDENTITY CASCADE;
    `);
  } finally {
    client.release();
  }
}

export async function createTestUser(
  app: FastifyInstance,
  email = 'testuser@example.com',
  password = 'password123'
): Promise<{ id: string; email: string; token: string }> {
  // Register
  const regRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password },
  });
  const regJson = JSON.parse(regRes.body);

  // Login
  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  const loginJson = JSON.parse(loginRes.body);

  return {
    id: regJson.user.id,
    email: regJson.user.email,
    token: loginJson.token,
  };
}

export async function createTestAccount(
  app: FastifyInstance,
  token: string,
  currency = 'USD'
): Promise<{ id: string; userId: string; currency: string; balance: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers: { authorization: `Bearer ${token}` },
    payload: { currency },
  });
  const json = JSON.parse(res.body);
  return json.account;
}

export async function depositToAccount(
  app: FastifyInstance,
  token: string,
  accountId: string,
  amount: number
): Promise<{ id: string; balance: number }> {
  const res = await app.inject({
    method: 'POST',
    url: `/accounts/${accountId}/deposit`,
    headers: { authorization: `Bearer ${token}` },
    payload: { amount },
  });
  const json = JSON.parse(res.body);
  return json.account;
}
