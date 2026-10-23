import { FastifyReply, FastifyRequest } from 'fastify';
import { transfersService } from './transfers.service';
import {
  createTransferSchema,
  reverseTransferParamsSchema,
  transferHeaderSchema,
} from './transfers.schema';
import { UnauthorizedError } from '../../utils/errors';

export class TransfersController {
  async transfer(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const headers = transferHeaderSchema.parse(request.headers);
    const body = createTransferSchema.parse(request.body);

    const idempotencyKey = headers['idempotency-key'];

    const result = await transfersService.executeTransfer(
      request.jwtUser.userId,
      body,
      idempotencyKey
    );

    return reply.status(200).send(result);
  }

  async reverse(request: FastifyRequest, reply: FastifyReply) {
    if (!request.jwtUser) {
      throw new UnauthorizedError();
    }

    const params = reverseTransferParamsSchema.parse(request.params);
    const result = await transfersService.reverseTransfer(params.id, request.jwtUser.userId);

    return reply.status(200).send(result);
  }
}

export const transfersController = new TransfersController();
