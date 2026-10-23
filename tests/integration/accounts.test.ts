import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool, createTestUser, createTestAccount, depositToAccount } from '../helpers/test-db';

describe('Accounts & Deposits Integration Tests', () => {
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

  it('POST /accounts - creates a wallet account with 0 initial balance', async () => {
    const user = await createTestUser(app, 'owner@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { currency: 'USD' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.account.userId).toBe(user.id);
    expect(body.account.currency).toBe('USD');
    expect(body.account.balance).toBe(0);
  });

  it('GET /accounts/:id - returns account details for owner', async () => {
    const user = await createTestUser(app, 'owner2@example.com');
    const account = await createTestAccount(app, user.token, 'USD');

    const res = await app.inject({
      method: 'GET',
      url: `/accounts/${account.id}`,
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.account.id).toBe(account.id);
    expect(body.account.balance).toBe(0);
  });

  it('GET /accounts/:id - returns 403 Forbidden when accessing another user account', async () => {
    const userA = await createTestUser(app, 'usera@example.com');
    const userB = await createTestUser(app, 'userb@example.com');
    const accountA = await createTestAccount(app, userA.token, 'USD');

    const res = await app.inject({
      method: 'GET',
      url: `/accounts/${accountA.id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('FORBIDDEN');
  });

  it('POST /accounts/:id/deposit - atomically deposits funds and creates ledger entry', async () => {
    const user = await createTestUser(app, 'depositor@example.com');
    const account = await createTestAccount(app, user.token, 'USD');

    const depositAmount = 5000; // $50.00 in cents
    const res = await app.inject({
      method: 'POST',
      url: `/accounts/${account.id}/deposit`,
      headers: {
        authorization: `Bearer ${user.token}`,
        'idempotency-key': 'deposit-test-key-1',
      },
      payload: { amount: depositAmount },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.account.balance).toBe(depositAmount);
    expect(body.transferId).toBeDefined();

    // Verify transfer record in DB
    const transferRes = await testPool.query('SELECT * FROM transfers WHERE id = $1', [body.transferId]);
    expect(transferRes.rows[0].from_account).toBeNull();
    expect(transferRes.rows[0].to_account).toBe(account.id);
    expect(parseInt(transferRes.rows[0].amount, 10)).toBe(depositAmount);
    expect(transferRes.rows[0].status).toBe('COMPLETED');

    // Verify ledger entry in DB
    const ledgerRes = await testPool.query('SELECT * FROM ledger_entries WHERE transfer_id = $1', [body.transferId]);
    expect(ledgerRes.rowCount).toBe(1);
    expect(ledgerRes.rows[0].account_id).toBe(account.id);
    expect(parseInt(ledgerRes.rows[0].amount, 10)).toBe(depositAmount);
  });

  it('GET /accounts/:id/transactions - returns paginated transactions with cursor & type filters', async () => {
    const user = await createTestUser(app, 'history@example.com');
    const account = await createTestAccount(app, user.token, 'USD');

    // Create 3 deposits
    for (let i = 1; i <= 3; i++) {
      await depositToAccount(app, user.token, account.id, i * 1000);
    }

    // Query with limit=2
    const resPage1 = await app.inject({
      method: 'GET',
      url: `/accounts/${account.id}/transactions?limit=2`,
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(resPage1.statusCode).toBe(200);
    const page1 = JSON.parse(resPage1.body);
    expect(page1.transactions.length).toBe(2);
    expect(page1.pagination.hasNextPage).toBe(true);
    expect(page1.pagination.nextCursor).toBeDefined();

    // Query page 2 with cursor
    const resPage2 = await app.inject({
      method: 'GET',
      url: `/accounts/${account.id}/transactions?limit=2&cursor=${page1.pagination.nextCursor}`,
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(resPage2.statusCode).toBe(200);
    const page2 = JSON.parse(resPage2.body);
    expect(page2.transactions.length).toBe(1);
    expect(page2.pagination.hasNextPage).toBe(false);

    // Query filter by type=CREDIT
    const resCredit = await app.inject({
      method: 'GET',
      url: `/accounts/${account.id}/transactions?type=CREDIT`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    const creditBody = JSON.parse(resCredit.body);
    expect(creditBody.transactions.length).toBe(3);
    expect(creditBody.transactions.every((t: any) => t.type === 'CREDIT')).toBe(true);
  });
});
