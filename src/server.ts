import { buildApp } from './app';
import { env } from './config/env';
import { pool } from './config/database';
import { logger } from './utils/logger';
import { outboxService } from './modules/outbox/outbox.service';

async function start() {
  const app = buildApp();

  // Graceful shutdown handling
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      logger.info({ signal }, 'Graceful shutdown initiated...');
      try {
        outboxService.stopPoller();
        await app.close();
        await pool.end();
        logger.info('Application, background workers, and database connections closed successfully.');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      }
    });
  }

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info(`Server listening on http://${env.HOST}:${env.PORT}`);
    logger.info(`OpenAPI Swagger documentation available at http://${env.HOST}:${env.PORT}/docs`);

    if (env.ENABLE_OUTBOX_WORKER) {
      outboxService.startPoller(env.OUTBOX_POLL_INTERVAL_MS);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to start Fastify server');
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}
