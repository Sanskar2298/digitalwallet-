import { z } from 'zod';

export const getTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  type: z.enum(['DEBIT', 'CREDIT', 'ALL']).default('ALL'),
  startDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
  endDate: z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()),
});

export const getTransactionsParamsSchema = z.object({
  id: z.string().uuid('Invalid account UUID'),
});

export type GetTransactionsQuery = z.infer<typeof getTransactionsQuerySchema>;
