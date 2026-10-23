import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { accountsController } from './accounts.controller';
import { ledgerController } from '../ledger/ledger.controller';

export const accountsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All account routes require JWT authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // POST /accounts
  fastify.post(
    '/',
    {
      schema: {
        description: 'Create a new wallet account',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            currency: { type: 'string', minLength: 3, maxLength: 3, default: 'USD' },
          },
        },
        response: {
          201: {
            description: 'Account created',
            type: 'object',
            properties: {
              message: { type: 'string' },
              account: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  userId: { type: 'string' },
                  currency: { type: 'string' },
                  balance: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    accountsController.createAccount.bind(accountsController)
  );

  // GET /accounts/:id
  fastify.get(
    '/:id',
    {
      schema: {
        description: 'Get account details by ID (must be account owner)',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              account: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  userId: { type: 'string' },
                  currency: { type: 'string' },
                  balance: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    accountsController.getAccount.bind(accountsController)
  );

  // POST /accounts/:id/deposit
  fastify.post(
    '/:id/deposit',
    {
      schema: {
        description: 'Deposit funds into an account with double-entry ledger entry',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', description: 'Optional unique idempotency key' },
          },
        },
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['amount'],
          properties: {
            amount: { type: 'integer', minimum: 1, description: 'Amount in minor units (e.g. cents)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              transferId: { type: 'string' },
              account: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  userId: { type: 'string' },
                  currency: { type: 'string' },
                  balance: { type: 'number' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
              depositedAmount: { type: 'number' },
              idempotencyKey: { type: 'string' },
            },
          },
        },
      },
    },
    accountsController.deposit.bind(accountsController)
  );

  // GET /accounts/:id/transactions (cursor pagination, filters by date and type)
  fastify.get(
    '/:id/transactions',
    {
      schema: {
        description: 'Get paginated ledger transactions with cursor pagination and date/type filtering',
        tags: ['Accounts', 'Ledger'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string', description: 'Base64 cursor for next page' },
            type: { type: 'string', enum: ['DEBIT', 'CREDIT', 'ALL'], default: 'ALL' },
            startDate: { type: 'string', description: 'Start date filter (ISO 8601 or YYYY-MM-DD)' },
            endDate: { type: 'string', description: 'End date filter (ISO 8601 or YYYY-MM-DD)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              transactions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    transferId: { type: 'string' },
                    accountId: { type: 'string' },
                    amount: { type: 'number' },
                    type: { type: 'string' },
                    fromAccount: { type: 'string', nullable: true },
                    toAccount: { type: 'string' },
                    status: { type: 'string' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
              pagination: {
                type: 'object',
                properties: {
                  limit: { type: 'number' },
                  hasNextPage: { type: 'boolean' },
                  nextCursor: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    ledgerController.getTransactions.bind(ledgerController)
  );
};
