import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/digital_wallet'),
  TEST_DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/digital_wallet_test'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters long'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(20),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_TRANSFER_MAX: z.coerce.number().default(60),
  RATE_LIMIT_TRANSFER_WINDOW_MS: z.coerce.number().default(60000),
  ADMIN_API_KEY: z.string().default('admin-secret-dev-key'),
  ENABLE_OUTBOX_WORKER: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(3000),
});

export const env = envSchema.parse(process.env);
