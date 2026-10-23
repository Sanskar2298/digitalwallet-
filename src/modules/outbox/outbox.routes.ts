import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { outboxService } from './outbox.service';
import { env } from '../../config/env';
import { ForbiddenError, UnauthorizedError } from '../../utils/errors';

export const outboxRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Admin authentication hook for outbox management
  fastify.addHook('preHandler', async (request) => {
    const adminKey = request.headers['x-admin-key'];
    if (!adminKey) {
      throw new UnauthorizedError('Missing required X-Admin-Key header');
    }
    if (adminKey !== env.ADMIN_API_KEY) {
      throw new ForbiddenError('Invalid administrative API key');
    }
  });

  // GET /outbox/events
  fastify.get(
    '/events',
    {
      schema: {
        description: 'Get list of transactional outbox events (Admin only)',
        tags: ['Outbox & Events'],
        headers: {
          type: 'object',
          required: ['x-admin-key'],
          properties: {
            'x-admin-key': { type: 'string', description: 'Internal admin API key' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    aggregateType: { type: 'string' },
                    aggregateId: { type: 'string' },
                    eventType: { type: 'string' },
                    payload: { type: 'object', additionalProperties: true },
                    status: { type: 'string' },
                    retryCount: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                    publishedAt: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { limit?: number };
      const events = await outboxService.getEvents(query.limit || 50);
      return reply.send({ events });
    }
  );

  // POST /outbox/process
  fastify.post(
    '/process',
    {
      schema: {
        description: 'Manually trigger background processing of pending outbox events (Admin only)',
        tags: ['Outbox & Events'],
        headers: {
          type: 'object',
          required: ['x-admin-key'],
          properties: {
            'x-admin-key': { type: 'string', description: 'Internal admin API key' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              processedCount: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const processedCount = await outboxService.publishPendingEvents();
      return reply.send({
        message: 'Outbox events processed and published successfully',
        processedCount,
      });
    }
  );
};
