import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import { env } from '../config/env';

const rateLimitPluginCallback: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(fastifyRateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Rate limit exceeded. Maximum ${context.max} requests per ${context.after}.`,
    }),
  });
};

export const rateLimitPlugin = fp(rateLimitPluginCallback, {
  name: 'rate-limit-plugin',
});

const isTest = env.NODE_ENV === 'test';

// Route specific rate limit options
export const authRateLimitConfig = {
  config: {
    rateLimit: {
      max: isTest ? 10000 : env.RATE_LIMIT_AUTH_MAX,
      timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS,
    },
  },
};

export const transferRateLimitConfig = {
  config: {
    rateLimit: {
      max: isTest ? 10000 : env.RATE_LIMIT_TRANSFER_MAX,
      timeWindow: env.RATE_LIMIT_TRANSFER_WINDOW_MS,
    },
  },
};
