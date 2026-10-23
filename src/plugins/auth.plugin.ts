import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';

declare module 'fastify' {
  interface FastifyRequest {
    jwtUser?: {
      userId: string;
      email: string;
    };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPluginCallback: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: env.JWT_SECRET,
  });

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const decoded = await request.jwtVerify<{ userId: string; email: string }>();
        request.jwtUser = decoded;
      } catch (err) {
        throw new UnauthorizedError('Missing, invalid, or expired authentication token');
      }
    }
  );
};

export const authPlugin = fp(authPluginCallback, {
  name: 'auth-plugin',
});
