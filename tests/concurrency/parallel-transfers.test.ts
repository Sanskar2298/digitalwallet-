import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool, createTestUser, createTestAccount, depositToAccount } from '../helpers/test-db';

describe('Concurrency Tests', () => {
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

  it('100 parallel bi-directional transfers on the same accounts: no deadlocks, balances correct, total money constant', async () => {
    const user1 = await createTestUser(app, 'conc_user1@example.com');
    const user2 = await createTestUser(app, 'conc_user2@example.com');

    const account1 = await createTestAccount(app, user1.token, 'USD');
    const account2 = await createTestAccount(app, user2.token, 'USD');

    const initialBalance1 = 1_000_000; // $10,000 in cents
    const initialBalance2 = 1_000_000; // $10,000 in cents
    const totalInitialMoney = initialBalance1 + initialBalance2;

    await depositToAccount(app, user1.token, account1.id, initialBalance1);
    await depositToAccount(app, user2.token, account2.id, initialBalance2);

    const transferAmount = 1000; // $10 per transfer
    const totalTransfers = 100;

    // 50 transfers from Account 1 -> Account 2
    // 50 transfers from Account 2 -> Account 1
    // Running simultaneously to stress lock order arbitration
    const promises = Array.from({ length: totalTransfers }).map((_, i) => {
      const isFrom1To2 = i % 2 === 0;
      const senderToken = isFrom1To2 ? user1.token : user2.token;
      const fromId = isFrom1To2 ? account1.id : account2.id;
      const toId = isFrom1To2 ? account2.id : account1.id;

      return app.inject({
        method: 'POST',
        url: '/transfers',
        headers: {
          authorization: `Bearer ${senderToken}`,
          'idempotency-key': `concurrent-tx-${i}-${Date.now()}`,
        },
        payload: {
          fromAccountId: fromId,
          toAccountId: toId,
          amount: transferAmount,
        },
      });
    });

    const results = await Promise.all(promises);

    // Verify all 100 transfers succeeded with 200 without any deadlock error
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.statusCode !== 200) {
        console.error(`Transfer ${i} failed with:`, res.body);
      }
      expect(res.statusCode).toBe(200);
    }

    // Check final account balances
    const acc1Res = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [account1.id]);
    const acc2Res = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [account2.id]);

    const finalBalance1 = parseInt(acc1Res.rows[0].balance, 10);
    const finalBalance2 = parseInt(acc2Res.rows[0].balance, 10);

    // Since 50 went one way and 50 went the other way with equal amounts, final balances must equal initial balances
    expect(finalBalance1).toBe(initialBalance1);
    expect(finalBalance2).toBe(initialBalance2);

    // CRITICAL INVARIANT: Total money in the system must remain strictly constant!
    const totalFinalMoney = finalBalance1 + finalBalance2;
    expect(totalFinalMoney).toBe(totalInitialMoney);

    // Verify total ledger entries for these transfers
    const ledgerSumRes = await testPool.query(
      `SELECT SUM(amount) as net_ledger_sum, count(*) as entry_count
       FROM ledger_entries
       WHERE transfer_id IN (
         SELECT id FROM transfers WHERE from_account IS NOT NULL
       )`
    );

    // Exactly 100 transfers * 2 entries = 200 ledger entries
    expect(parseInt(ledgerSumRes.rows[0].entry_count, 10)).toBe(200);
    // Double-entry net sum must equal exactly ZERO
    expect(parseInt(ledgerSumRes.rows[0].net_ledger_sum, 10)).toBe(0);
  });
});
