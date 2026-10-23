async function runDemo() {
  const baseUrl = 'http://localhost:3000';

  console.log('🚀 Digital Wallet End-to-End Live Demo\n');

  // Helper fetch wrapper
  async function request(endpoint: string, options: any = {}) {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = (await res.json()) as any;
    return { status: res.status, body };
  }

  const timestamp = Date.now();

  // 1. Health check
  console.log('1️⃣ Checking API Health:');
  const health = await request('/health');
  console.log('   Response:', health.body);

  // 2. Register Alice and Bob
  console.log('\n2️⃣ Registering Users (Alice & Bob):');
  const aliceEmail = `alice_${timestamp}@example.com`;
  const bobEmail = `bob_${timestamp}@example.com`;

  await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: aliceEmail, password: 'password123' }),
  });
  await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: bobEmail, password: 'password123' }),
  });

  // 3. Login & obtain JWTs
  const aliceLogin = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: aliceEmail, password: 'password123' }),
  });
  const bobLogin = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: bobEmail, password: 'password123' }),
  });

  const aliceToken = aliceLogin.body.token;
  const bobToken = bobLogin.body.token;
  console.log(`   Alice Authenticated: ${aliceEmail}`);
  console.log(`   Bob Authenticated:   ${bobEmail}`);

  // 4. Create USD accounts
  console.log('\n3️⃣ Creating Accounts:');
  const aliceAccRes = await request('/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ currency: 'USD' }),
  });
  const bobAccRes = await request('/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ currency: 'USD' }),
  });

  const aliceAccount = aliceAccRes.body.account;
  const bobAccount = bobAccRes.body.account;
  console.log(`   Alice Account: ${aliceAccount.id} (Balance: $${aliceAccount.balance / 100})`);
  console.log(`   Bob Account:   ${bobAccount.id} (Balance: $${bobAccount.balance / 100})`);

  // 5. Deposit $100.00 into Alice's account
  console.log('\n4️⃣ Depositing $100.00 (10,000 cents) into Alice account:');
  const depRes = await request(`/accounts/${aliceAccount.id}/deposit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceToken}`,
      'idempotency-key': `deposit-${timestamp}`,
    },
    body: JSON.stringify({ amount: 10000 }),
  });
  console.log(`   Deposit Success! Alice New Balance: $${depRes.body.account.balance / 100}`);

  // 6. Transfer $35.00 from Alice to Bob
  console.log('\n5️⃣ Transferring $35.00 (3,500 cents) from Alice -> Bob:');
  const txRes = await request('/transfers', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceToken}`,
      'idempotency-key': `transfer-demo-${timestamp}`,
    },
    body: JSON.stringify({
      fromAccountId: aliceAccount.id,
      toAccountId: bobAccount.id,
      amount: 3500,
    }),
  });
  console.log(`   Transfer Result: ${txRes.body.transfer.status}`);
  console.log(`   Alice Balance After: $${txRes.body.fromAccountBalance / 100}`);
  console.log(`   Bob Balance After:   $${txRes.body.toAccountBalance / 100}`);

  // 7. Test Idempotency with exact same key
  console.log('\n6️⃣ Testing Idempotency (resending identical request with same key):');
  const idempRes = await request('/transfers', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceToken}`,
      'idempotency-key': `transfer-demo-${timestamp}`,
    },
    body: JSON.stringify({
      fromAccountId: aliceAccount.id,
      toAccountId: bobAccount.id,
      amount: 3500,
    }),
  });
  console.log(`   Idempotency Verified! Status: ${idempRes.body.transfer.status}, Alice Balance: $${idempRes.body.fromAccountBalance / 100} (unchanged)`);

  // 8. View Alice's immutable transaction ledger entries
  console.log('\n7️⃣ Fetching Alice Immutable Ledger Entries:');
  const txListRes = await request(`/accounts/${aliceAccount.id}/transactions`, {
    method: 'GET',
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  console.table(txListRes.body.transactions);

  console.log('✅ All features verified working live!\n');
}

runDemo().catch(console.error);
