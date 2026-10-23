import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool, createTestUser, createTestAccount, depositToAccount } from '../helpers/test-db';

describe('Transfers Integration Tests', () => {
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

  it('POST /transfers - successfully transfers money with balanced double-entry ledger', async () => {
    const sender = await createTestUser(app, 'sender@example.com');
    const recipient = await createTestUser(app, 'recipient@example.com');

    const fromAccount = await createTestAccount(app, sender.token, 'USD');
    const toAccount = await createTestAccount(app, recipient.token, 'USD');

    // Fund sender account with $100.00 (10000 cents)
    await depositToAccount(app, sender.token, fromAccount.id, 10000);

    const transferAmount = 3500; // $35.00
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'idempotency-key': 'transfer-key-1',
      },
      payload: {
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        amount: transferAmount,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fromAccountBalance).toBe(6500);
    expect(body.toAccountBalance).toBe(3500);
    expect(body.transfer.id).toBeDefined();

    // Verify double-entry ledger entries in database
    const ledgerRes = await testPool.query(
      'SELECT account_id, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY amount ASC',
      [body.transfer.id]
    );

    expect(ledgerRes.rowCount).toBe(2);
    // Debit entry
    expect(ledgerRes.rows[0].account_id).toBe(fromAccount.id);
    expect(parseInt(ledgerRes.rows[0].amount, 10)).toBe(-transferAmount);
    // Credit entry
    expect(ledgerRes.rows[1].account_id).toBe(toAccount.id);
    expect(parseInt(ledgerRes.rows[1].amount, 10)).toBe(transferAmount);

    // Sum of ledger entries must be exactly ZERO (double-entry invariant)
    const sum = parseInt(ledgerRes.rows[0].amount, 10) + parseInt(ledgerRes.rows[1].amount, 10);
    expect(sum).toBe(0);
  });

  it('POST /transfers - fails with 422 and rolls back when balance is insufficient', async () => {
    const sender = await createTestUser(app, 'poor_sender@example.com');
    const recipient = await createTestUser(app, 'poor_recipient@example.com');

    const fromAccount = await createTestAccount(app, sender.token, 'USD');
    const toAccount = await createTestAccount(app, recipient.token, 'USD');

    // Deposit only 2000 cents
    await depositToAccount(app, sender.token, fromAccount.id, 2000);

    // Attempt to transfer 5000 cents
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'idempotency-key': 'insufficient-funds-key',
      },
      payload: {
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        amount: 5000,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('INSUFFICIENT_FUNDS');

    // Verify rollback: balances untouched, no transfer or ledger entries
    const fromCheck = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [fromAccount.id]);
    expect(parseInt(fromCheck.rows[0].balance, 10)).toBe(2000);

    const toCheck = await testPool.query('SELECT balance FROM accounts WHERE id = $1', [toAccount.id]);
    expect(parseInt(toCheck.rows[0].balance, 10)).toBe(0);

    const transfersCount = await testPool.query('SELECT count(*) FROM transfers WHERE idempotency_key = $1', ['insufficient-funds-key']);
    expect(parseInt(transfersCount.rows[0].count, 10)).toBe(0);
  });

  it('POST /transfers - rejects unauthorized sender with 403 Forbidden', async () => {
    const legitimateOwner = await createTestUser(app, 'legit@example.com');
    const hacker = await createTestUser(app, 'hacker@example.com');

    const victimAccount = await createTestAccount(app, legitimateOwner.token, 'USD');
    const hackerAccount = await createTestAccount(app, hacker.token, 'USD');
    await depositToAccount(app, legitimateOwner.token, victimAccount.id, 5000);

    // Hacker tries to initiate transfer from victimAccount
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${hacker.token}`,
        'idempotency-key': 'hack-attempt-1',
      },
      payload: {
        fromAccountId: victimAccount.id,
        toAccountId: hackerAccount.id,
        amount: 5000,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('FORBIDDEN');
  });

  it('POST /transfers/:id/reverse - successfully reverses transfer by appending new ledger entries', async () => {
    const sender = await createTestUser(app, 'rev_sender@example.com');
    const recipient = await createTestUser(app, 'rev_recipient@example.com');

    const fromAccount = await createTestAccount(app, sender.token, 'USD');
    const toAccount = await createTestAccount(app, recipient.token, 'USD');

    await depositToAccount(app, sender.token, fromAccount.id, 10000);

    // 1. Initial transfer: $40.00
    const transferRes = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'idempotency-key': 'transfer-to-reverse',
      },
      payload: {
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        amount: 4000,
      },
    });
    const transferData = JSON.parse(transferRes.body);

    // 2. Reverse transfer
    const reverseRes = await app.inject({
      method: 'POST',
      url: `/transfers/${transferData.transfer.id}/reverse`,
      headers: { authorization: `Bearer ${sender.token}` },
    });

    expect(reverseRes.statusCode).toBe(200);
    const reverseData = JSON.parse(reverseRes.body);
    expect(reverseData.senderNewBalance).toBe(10000);
    expect(reverseData.recipientNewBalance).toBe(0);

    // 3. Verify database: Total 4 ledger entries exist (2 original, 2 reversal), none edited
    const allLedger = await testPool.query('SELECT * FROM ledger_entries ORDER BY created_at ASC');
    // 1 deposit + 2 transfer + 2 reversal = 5 total
    expect(allLedger.rowCount).toBe(5);

    // 4. Verify trigger prevents any tampering / edits on ledger_entries
    await expect(
      testPool.query('UPDATE ledger_entries SET amount = 9999 WHERE id = $1', [allLedger.rows[0].id])
    ).rejects.toThrow(/insert-only|prohibited|tampering/i);
  });
});
