import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function centralizedErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // 1. Zod Validation Errors
  if (error instanceof ZodError) {
    const formatted = error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    return reply.status(400).send({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: formatted,
    });
  }

  // 2. Custom Domain Application Errors
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  // 3. PostgreSQL Specific Errors
  const pgErr = error as any;
  if (pgErr.code === '23505') {
    // Unique constraint violation (e.g., duplicate email or idempotency_key)
    return reply.status(409).send({
      statusCode: 409,
      error: 'CONFLICT',
      message: 'A duplicate record already exists with this unique identifier',
      detail: pgErr.detail,
    });
  }

  if (pgErr.code === '23514') {
    // Check constraint violation (e.g., balance >= 0 or amount > 0)
    return reply.status(422).send({
      statusCode: 422,
      error: 'CHECK_VIOLATION',
      message: 'Constraint violation: insufficient balance or invalid monetary amount',
    });
  }

  // 4. Fastify Rate Limit Error (429)
  if ((error as any).statusCode === 429) {
    return reply.status(429).send({
      statusCode: 429,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later.',
    });
  }

  // 5. Fastify Schema Validation Error
  if ((error as any).validation) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'BAD_REQUEST',
      message: error.message,
    });
  }

  // 6. Unhandled / Internal Server Error
  logger.error(
    {
      err: error,
      reqId: request.id,
      url: request.raw.url,
      method: request.raw.method,
    },
    'Centralized Error Handler caught unhandled error'
  );

  return reply.status(500).send({
    statusCode: 500,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal server error occurred',
  });
}
