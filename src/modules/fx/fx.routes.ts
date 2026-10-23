import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { fxService } from './fx.service';

export const fxRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /fx/rates
  fastify.get(
    '/rates',
    {
      schema: {
        description: 'Get all available foreign exchange (FX) rates',
        tags: ['Foreign Exchange (FX)'],
        response: {
          200: {
            type: 'object',
            properties: {
              rates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    baseCurrency: { type: 'string' },
                    targetCurrency: { type: 'string' },
                    rate: { type: 'number' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rates = await fxService.listRates();
      return reply.send({ rates });
    }
  );
};
