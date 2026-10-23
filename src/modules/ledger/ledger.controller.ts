import { FastifyReply, FastifyRequest } from 'fastify';
import { ledgerService } from './ledger.service';
import { getTransactionsParamsSchema, getTransactionsQuerySchema } from './ledger.schema';
import { UnauthorizedError } from '../../utils/errors';

export class LedgerController {
  async getTransactions(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const params = getTransactionsParamsSchema.parse(request.params);
    const query = getTransactionsQuerySchema.parse(request.query);

    const result = await ledgerService.getAccountTransactions(
      params.id,
      request.jwtUser.userId,
      query
    );

    return reply.status(200).send(result);
  }
}

export const ledgerController = new LedgerController();
