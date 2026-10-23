import { FastifyInstance } from 'fastify';
import { setupTestEnvironment, resetDatabase, testPool } from '../helpers/test-db';

describe('Auth Integration Tests', () => {
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

  it('POST /auth/register - successfully registers a new user with hashed password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'alice@example.com',
        password: 'securePassword123',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('User registered successfully');
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.id).toBeDefined();

    // Verify password is not plaintext in DB
    const dbRes = await testPool.query('SELECT password_hash FROM users WHERE id = $1', [body.user.id]);
    expect(dbRes.rows[0].password_hash).not.toBe('securePassword123');
    expect(dbRes.rows[0].password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('POST /auth/register - fails with 409 Conflict if email is already taken', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'alice@example.com',
        password: 'securePassword123',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'alice@example.com',
        password: 'anotherPassword123',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('CONFLICT');
  });

  it('POST /auth/register - fails with 400 for invalid inputs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'not-an-email',
        password: 'short',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(['VALIDATION_ERROR', 'BAD_REQUEST']).toContain(body.error);
  });

  it('POST /auth/login - returns JWT token on valid credentials', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'bob@example.com',
        password: 'password123',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'bob@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeDefined();
    expect(body.user.email).toBe('bob@example.com');
  });

  it('POST /auth/login - returns 401 on wrong password', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'bob@example.com',
        password: 'password123',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'bob@example.com',
        password: 'wrongPassword',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('UNAUTHORIZED');
  });
});
