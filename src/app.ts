import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { authPlugin } from './plugins/auth.plugin';
import { swaggerPlugin } from './plugins/swagger.plugin';
import { rateLimitPlugin } from './plugins/rate-limit.plugin';
import { centralizedErrorHandler } from './plugins/error-handler';
import { authRoutes } from './modules/auth/auth.routes';
import { accountsRoutes } from './modules/accounts/accounts.routes';
import { transfersRoutes } from './modules/transfers/transfers.routes';
import { fxRoutes } from './modules/fx/fx.routes';
import { outboxRoutes } from './modules/outbox/outbox.routes';
import { checkDatabaseConnection } from './config/database';
import { logger } from './utils/logger';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger as any,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  // Centralized Error Handling
  app.setErrorHandler(centralizedErrorHandler);

  // Core Plugins
  app.register(cors, { origin: true });
  app.register(swaggerPlugin);
  app.register(authPlugin);
  app.register(rateLimitPlugin);

  // Health check endpoint
  app.get('/health', async (request, reply) => {
    const isDbConnected = await checkDatabaseConnection();
    const status = isDbConnected ? 'UP' : 'DEGRADED';
    return reply.status(isDbConnected ? 200 : 503).send({
      status,
      timestamp: new Date().toISOString(),
      database: isDbConnected ? 'CONNECTED' : 'DISCONNECTED',
    });
  });

  // API Routes
  app.register(authRoutes, { prefix: '/auth' });
  app.register(accountsRoutes, { prefix: '/accounts' });
  app.register(transfersRoutes, { prefix: '/transfers' });
  app.register(fxRoutes, { prefix: '/fx' });
  app.register(outboxRoutes, { prefix: '/outbox' });

  return app;
}
