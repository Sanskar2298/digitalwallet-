import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool, createTestUser, createTestAccount, depositToAccount } from '../helpers/test-db';
import { outboxService } from '../../src/modules/outbox/outbox.service';

describe('Multi-Currency FX, Chart of Accounts & Outbox Tests', () => {
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

  it('Executes multi-currency transfer with true double-entry via SYSTEM_FX_CLEARING (USD -> EUR)', async () => {
    const userA = await createTestUser(app, 'fx_alice@example.com');
    const userB = await createTestUser(app, 'fx_bob@example.com');

    // Alice has USD wallet, Bob has EUR wallet
    const aliceUsdAccount = await createTestAccount(app, userA.token, 'USD');
    const bobEurAccount = await createTestAccount(app, userB.token, 'EUR');

    // Deposit $100.00 (10000 cents) into Alice USD wallet
    await depositToAccount(app, userA.token, aliceUsdAccount.id, 10000);

    // Transfer $50.00 (5000 cents) USD to Bob EUR wallet
    // At FX rate 0.92, 5000 * 0.92 = 4600 EUR cents (€46.00)
    const transferRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'idempotency-key': 'fx-transfer-test-1',
      },
      payload: {
        fromAccountId: aliceUsdAccount.id,
        toAccountId: bobEurAccount.id,
        amount: 5000,
      },
    });

    expect(transferRes.statusCode).toBe(200);
    const body = JSON.parse(transferRes.body);
    expect(body.transfer.sourceAmount).toBe(5000);
    expect(body.transfer.sourceCurrency).toBe('USD');
    expect(body.transfer.destinationAmount).toBe(4600);
    expect(body.transfer.destinationCurrency).toBe('EUR');
    expect(body.transfer.exchangeRate).toBe(0.92);

    // Alice balance after: 10000 - 5000 = 5000 USD cents
    expect(body.fromAccountBalance).toBe(5000);
    // Bob balance after: 0 + 4600 = 4600 EUR cents
    expect(body.toAccountBalance).toBe(4600);

    // Verify database balances
    const aliceDb = await testPool.query('SELECT balance, currency FROM accounts WHERE id = $1', [aliceUsdAccount.id]);
    expect(parseInt(aliceDb.rows[0].balance, 10)).toBe(5000);

    const bobDb = await testPool.query('SELECT balance, currency FROM accounts WHERE id = $1', [bobEurAccount.id]);
    expect(parseInt(bobDb.rows[0].balance, 10)).toBe(4600);

    // Verify true 4-entry double-entry ledger:
    // USD entries sum to 0 (-5000 + 5000)
    // EUR entries sum to 0 (-4600 + 4600)
    const ledger = await testPool.query<{ amount: string; currency: string }>(
      `SELECT le.amount, a.currency 
       FROM ledger_entries le 
       INNER JOIN accounts a ON a.id = le.account_id 
       WHERE le.transfer_id = $1`,
      [body.transfer.id]
    );
    expect(ledger.rowCount).toBe(4);

    const usdSum = ledger.rows
      .filter((r) => r.currency === 'USD')
      .reduce((acc, r) => acc + parseInt(r.amount, 10), 0);
    const eurSum = ledger.rows
      .filter((r) => r.currency === 'EUR')
      .reduce((acc, r) => acc + parseInt(r.amount, 10), 0);

    expect(usdSum).toBe(0);
    expect(eurSum).toBe(0);
  });

  it('Calculates correct minor-unit conversion for 0-decimal currencies (USD -> JPY)', async () => {
    const userA = await createTestUser(app, 'jpy_alice@example.com');
    const userB = await createTestUser(app, 'jpy_bob@example.com');

    const aliceUsd = await createTestAccount(app, userA.token, 'USD');
    const bobJpy = await createTestAccount(app, userB.token, 'JPY');

    // Deposit $50.00 (5000 cents)
    await depositToAccount(app, userA.token, aliceUsd.id, 5000);

    // Transfer $50.00 to JPY.
    // USD has 2 decimals, JPY has 0 decimals.
    // Rate = 150.0. Calculation: 5000 * 150 * 10^(0 - 2) = 7500 JPY (¥7,500)
    const transferRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'idempotency-key': 'usd-to-jpy-test',
      },
      payload: {
        fromAccountId: aliceUsd.id,
        toAccountId: bobJpy.id,
        amount: 5000,
      },
    });

    expect(transferRes.statusCode).toBe(200);
    const body = JSON.parse(transferRes.body);
    expect(body.transfer.destinationAmount).toBe(7500); // ¥7,500, NOT 750,000!

    const bobDb = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [bobJpy.id]);
    expect(parseInt(bobDb.rows[0].balance, 10)).toBe(7500);
  });

  it('Rejects idempotency key reuse with mismatched request payload (Stripe 422 behavior)', async () => {
    const userA = await createTestUser(app, 'idem_alice@example.com');
    const userB = await createTestUser(app, 'idem_bob@example.com');

    const aliceAcc = await createTestAccount(app, userA.token, 'USD');
    const bobAcc = await createTestAccount(app, userB.token, 'USD');
    await depositToAccount(app, userA.token, aliceAcc.id, 10000);

    const idempotencyKey = 'shared-idempotency-key-1';

    // 1st request: transfer $10.00
    const firstRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        fromAccountId: aliceAcc.id,
        toAccountId: bobAcc.id,
        amount: 1000,
      },
    });
    expect(firstRes.statusCode).toBe(200);

    // 2nd request: identical key but different amount ($20.00)
    const mismatchedRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${userA.token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        fromAccountId: aliceAcc.id,
        toAccountId: bobAcc.id,
        amount: 2000,
      },
    });
    expect(mismatchedRes.statusCode).toBe(422);
    const errBody = JSON.parse(mismatchedRes.body);
    expect(errBody.error).toBe('UNPROCESSABLE_ENTITY');
    expect(errBody.message).toContain('different request payload');
  });

  it('Restricts outbox endpoints with X-Admin-Key authentication', async () => {
    // Unauthenticated GET /outbox/events missing required header -> Fastify schema validator returns 400
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/outbox/events',
    });
    expect(unauthRes.statusCode).toBe(400);

    // Invalid key -> 403
    const badKeyRes = await app.inject({
      method: 'GET',
      url: '/outbox/events',
      headers: { 'x-admin-key': 'wrong-key' },
    });
    expect(badKeyRes.statusCode).toBe(403);

    // Valid admin key -> 200
    const validRes = await app.inject({
      method: 'GET',
      url: '/outbox/events',
      headers: { 'x-admin-key': 'admin-secret-dev-key' },
    });
    expect(validRes.statusCode).toBe(200);
  });

  it('Emits and dispatches events via Transactional Outbox Pattern', async () => {
    const user = await createTestUser(app, 'outbox_user@example.com');
    const account = await createTestAccount(app, user.token, 'USD');

    // Deposit funds triggers outbox emission
    await depositToAccount(app, user.token, account.id, 7500);

    // Check outbox table: event must be PENDING
    const outboxRes = await testPool.query('SELECT * FROM outbox_events WHERE aggregate_id = $1', [account.id]);
    expect(outboxRes.rowCount).toBeGreaterThanOrEqual(1);
    expect(outboxRes.rows[0].event_type).toBe('deposit.completed');
    expect(outboxRes.rows[0].status).toBe('PENDING');

    // Publish pending outbox events
    const publishedCount = await outboxService.publishPendingEvents();
    expect(publishedCount).toBeGreaterThanOrEqual(1);

    // Verify status changed to PUBLISHED
    const updatedOutbox = await testPool.query('SELECT * FROM outbox_events WHERE id = $1', [outboxRes.rows[0].id]);
    expect(updatedOutbox.rows[0].status).toBe('PUBLISHED');
    expect(updatedOutbox.rows[0].published_at).not.toBeNull();
  });

  it('Chart of accounts records account_type on creation', async () => {
    const user = await createTestUser(app, 'chart_user@example.com');
    const account = await createTestAccount(app, user.token, 'USD');

    const dbAcc = await testPool.query('SELECT account_type FROM accounts WHERE id = $1', [account.id]);
    expect(dbAcc.rows[0].account_type).toBe('CUSTOMER_WALLET');
  });

  it('GET /fx/rates - returns active foreign exchange rates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/fx/rates',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.rates)).toBe(true);
    expect(body.rates.some((r: any) => r.baseCurrency === 'USD' && r.targetCurrency === 'EUR')).toBe(true);
  });
});
