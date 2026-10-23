import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { transfersController } from './transfers.controller';
import { transferRateLimitConfig } from '../../plugins/rate-limit.plugin';

export const transfersRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // POST /transfers (requires Idempotency-Key header & rate limiting)
  fastify.post(
    '/',
    {
      ...transferRateLimitConfig,
      schema: {
        description: 'Execute an atomic transfer between two accounts with double-entry ledger bookkeeping',
        tags: ['Transfers'],
        security: [{ bearerAuth: [] }],
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              description: 'Unique key ensuring safe retries without duplicate executions',
            },
          },
        },
        body: {
          type: 'object',
          required: ['fromAccountId', 'toAccountId', 'amount'],
          properties: {
            fromAccountId: { type: 'string', format: 'uuid' },
            toAccountId: { type: 'string', format: 'uuid' },
            amount: { type: 'integer', minimum: 1, description: 'Amount in minor units (cents)' },
          },
        },
        response: {
          200: {
            description: 'Transfer successful',
            type: 'object',
            properties: {
              message: { type: 'string' },
              transfer: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  fromAccountId: { type: 'string' },
                  toAccountId: { type: 'string' },
                  amount: { type: 'number' },
                  sourceAmount: { type: 'number' },
                  sourceCurrency: { type: 'string' },
                  destinationAmount: { type: 'number' },
                  destinationCurrency: { type: 'string' },
                  exchangeRate: { type: 'number' },
                  currency: { type: 'string' },
                  status: { type: 'string' },
                  idempotencyKey: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
              fromAccountBalance: { type: 'number' },
              toAccountBalance: { type: 'number' },
            },
          },
        },
      },
    },
    transfersController.transfer.bind(transfersController)
  );

  // POST /transfers/:id/reverse
  fastify.post(
    '/:id/reverse',
    {
      schema: {
        description: 'Reverse a previously completed transfer by creating new offsetting ledger entries',
        tags: ['Transfers'],
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
            description: 'Transfer reversed',
            type: 'object',
            properties: {
              message: { type: 'string' },
              originalTransferId: { type: 'string' },
              reversalTransferId: { type: 'string' },
              amount: { type: 'number' },
              senderNewBalance: { type: 'number' },
              recipientNewBalance: { type: 'number' },
            },
          },
        },
      },
    },
    transfersController.reverse.bind(transfersController)
  );
};
