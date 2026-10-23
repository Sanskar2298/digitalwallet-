import { FastifyReply, FastifyRequest } from 'fastify';
import { accountsService } from './accounts.service';
import { createAccountSchema, depositSchema, getAccountParamsSchema } from './accounts.schema';
import { UnauthorizedError } from '../../utils/errors';

export class AccountsController {
  async createAccount(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const input = createAccountSchema.parse(request.body || {});
    const account = await accountsService.createAccount(request.jwtUser.userId, input);

    return reply.status(201).send({
      message: 'Account created successfully',
      account,
    });
  }

  async getAccount(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const params = getAccountParamsSchema.parse(request.params);
    const account = await accountsService.getAccountById(params.id, request.jwtUser.userId);

    return reply.status(200).send({
      account,
    });
  }

  async deposit(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const params = getAccountParamsSchema.parse(request.params);
    const body = depositSchema.parse(request.body);
    const idempotencyKey = (request.headers['idempotency-key'] as string) || undefined;

    const result = await accountsService.deposit(
      params.id,
      request.jwtUser.userId,
      body.amount,
      idempotencyKey
    );

    return reply.status(200).send(result);
  }
}

export const accountsController = new AccountsController();
