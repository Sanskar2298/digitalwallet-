import { z } from 'zod';

export const createAccountSchema = z.object({
  currency: z.string().length(3, 'Currency must be a 3-letter ISO code').toUpperCase().default('USD'),
});

export const getAccountParamsSchema = z.object({
  id: z.string().uuid('Invalid account UUID'),
});

export const depositSchema = z.object({
  amount: z.coerce.number().int().positive('Deposit amount must be a positive integer in minor units (cents)'),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type DepositInput = z.infer<typeof depositSchema>;
