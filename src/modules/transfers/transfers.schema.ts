import { z } from 'zod';

export const createTransferSchema = z.object({
  fromAccountId: z.string().uuid('fromAccountId must be a valid UUID'),
  toAccountId: z.string().uuid('toAccountId must be a valid UUID'),
  amount: z.coerce.number().int().positive('Transfer amount must be a positive integer in minor units (cents)'),
}).refine((data) => data.fromAccountId !== data.toAccountId, {
  message: 'fromAccountId and toAccountId cannot be the same account',
  path: ['toAccountId'],
});

export const transferHeaderSchema = z.object({
  'idempotency-key': z.string().min(1, 'Idempotency-Key header is required'),
});

export const reverseTransferParamsSchema = z.object({
  id: z.string().uuid('Transfer ID must be a valid UUID'),
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
