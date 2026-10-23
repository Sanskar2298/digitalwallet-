import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authController } from './auth.controller';
import { authRateLimitConfig } from '../../plugins/rate-limit.plugin';

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /auth/register
  fastify.post(
    '/register',
    {
      ...authRateLimitConfig,
      schema: {
        description: 'Register a new user',
        tags: ['Authentication'],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
        response: {
          201: {
            description: 'User registered successfully',
            type: 'object',
            properties: {
              message: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    authController.register.bind(authController)
  );

  // POST /auth/login
  fastify.post(
    '/login',
    {
      ...authRateLimitConfig,
      schema: {
        description: 'Authenticate user and obtain JWT token',
        tags: ['Authentication'],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          },
        },
        response: {
          200: {
            description: 'Authentication successful',
            type: 'object',
            properties: {
              message: { type: 'string' },
              token: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    authController.login.bind(authController)
  );
};
