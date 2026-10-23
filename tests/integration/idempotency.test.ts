import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool, createTestUser, createTestAccount, depositToAccount } from '../helpers/test-db';

describe('Idempotency Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await setupTestEnvironment();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await testPool.end();
  });

  it('Same idempotency key sent 10 times produces exactly ONE transfer and debits once', async () => {
    const userA = await createTestUser(app, 'idemp_user_a@example.com');
    const userB = await createTestUser(app, 'idemp_user_b@example.com');

    const accountA = await createTestAccount(app, userA.token, 'USD');
    const accountB = await createTestAccount(app, userB.token, 'USD');

    // Fund account A with $100.00 (10000 cents)
    await depositToAccount(app, userA.token, accountA.id, 10000);

    const idempotencyKey = 'unique-idempotency-key-xyz-123';
    const transferAmount = 2500; // $25.00

    // Send 10 identical requests
    const responses = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        app.inject({
          method: 'POST',
          url: '/transfers',
          headers: {
            authorization: `Bearer ${userA.token}`,
            'idempotency-key': idempotencyKey,
          },
          payload: {
            fromAccountId: accountA.id,
            toAccountId: accountB.id,
            amount: transferAmount,
          },
        })
      )
    );

    // All 10 requests must succeed with 200
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    // All 10 responses must return the identical transfer ID
    const firstTransferId = JSON.parse(responses[0].body).transfer.id;
    for (const res of responses) {
      const data = JSON.parse(res.body);
      expect(data.transfer.id).toBe(firstTransferId);
    }

    // Database verification: Exactly ONE transfer record exists with this key
    const transferCount = await testPool.query(
      'SELECT count(*) FROM transfers WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    expect(parseInt(transferCount.rows[0].count, 10)).toBe(1);

    // Exactly TWO ledger entries created (one debit, one credit)
    const ledgerCount = await testPool.query(
      'SELECT count(*) FROM ledger_entries WHERE transfer_id = $1',
      [firstTransferId]
    );
    expect(parseInt(ledgerCount.rows[0].count, 10)).toBe(2);

    // Account balances: debited and credited exactly once ($100 - $25 = $75)
    const accA = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [accountA.id]);
    expect(parseInt(accA.rows[0].balance, 10)).toBe(7500);

    const accB = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [accountB.id]);
    expect(parseInt(accB.rows[0].balance, 10)).toBe(2500);
  });
});
