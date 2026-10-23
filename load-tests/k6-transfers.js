import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const transferSuccessRate = new Rate('successful_transfers');
const transferDuration = new Trend('transfer_duration_ms');

export const options = {
  stages: [
    { duration: '5s', target: 20 },  // Ramp-up to 20 virtual users
    { duration: '15s', target: 50 }, // Sustained peak at 50 VUs
    { duration: '5s', target: 0 },   // Ramp-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<250'], // 95% of requests should be below 250ms
    'successful_transfers': ['rate>0.99'], // >99% success rate
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';

// Global setup: Create 2 users, accounts, and fund them
export function setup() {
  const timestamp = Date.now();

  // 1. Create User 1
  const u1Email = `k6_user1_${timestamp}@example.com`;
  http.post(`${BASE_URL}/auth/register`, JSON.stringify({ email: u1Email, password: 'password123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const u1Login = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email: u1Email, password: 'password123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const token1 = JSON.parse(u1Login.body).token;

  // Create & fund Account 1
  const acc1Res = http.post(`${BASE_URL}/accounts`, JSON.stringify({ currency: 'USD' }), {
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token1}` },
  });
  const acc1Id = JSON.parse(acc1Res.body).account.id;
  http.post(`${BASE_URL}/accounts/${acc1Id}/deposit`, JSON.stringify({ amount: 10000000 }), {
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token1}` },
  });

  // 2. Create User 2
  const u2Email = `k6_user2_${timestamp}@example.com`;
  http.post(`${BASE_URL}/auth/register`, JSON.stringify({ email: u2Email, password: 'password123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const u2Login = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email: u2Email, password: 'password123' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const token2 = JSON.parse(u2Login.body).token;

  // Create & fund Account 2
  const acc2Res = http.post(`${BASE_URL}/accounts`, JSON.stringify({ currency: 'USD' }), {
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token2}` },
  });
  const acc2Id = JSON.parse(acc2Res.body).account.id;
  http.post(`${BASE_URL}/accounts/${acc2Id}/deposit`, JSON.stringify({ amount: 10000000 }), {
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token2}` },
  });

  return { token1, token2, acc1Id, acc2Id };
}

export default function (data) {
  const isUser1ToUser2 = Math.random() > 0.5;
  const token = isUser1ToUser2 ? data.token1 : data.token2;
  const fromAccountId = isUser1ToUser2 ? data.acc1Id : data.acc2Id;
  const toAccountId = isUser1ToUser2 ? data.acc2Id : data.acc1Id;

  const idempotencyKey = `k6-tx-${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    fromAccountId,
    toAccountId,
    amount: 100, // $1.00
  });

  const headers = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
    'idempotency-key': idempotencyKey,
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/transfers`, payload, { headers });
  const latency = Date.now() - startTime;

  transferDuration.add(latency);
  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'transfer id present': (r) => {
      try {
        return JSON.parse(r.body).transfer.id !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  transferSuccessRate.add(success);

  // Short pacing delay between requests
  sleep(0.05);
}
