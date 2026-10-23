import { FastifyReply, FastifyRequest } from 'fastify';
import { authService } from './auth.service';
import { loginSchema, registerSchema } from './auth.schema';

export class AuthController {
  async register(request: FastifyRequest, reply: FastifyReply) {
    const input = registerSchema.parse(request.body);
    const user = await authService.register(input);

    return reply.status(201).send({
      message: 'User registered successfully',
      user,
    });
  }

  async login(request: FastifyRequest, reply: FastifyReply) {
    const input = loginSchema.parse(request.body);
    const user = await authService.login(input);

    const token = await reply.jwtSign({
      userId: user.id,
      email: user.email,
    });

    return reply.status(200).send({
      message: 'Authentication successful',
      token,
      user,
    });
  }
}

export const authController = new AuthController();
