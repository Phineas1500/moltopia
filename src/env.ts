import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('3000'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  API_RATE_LIMIT_PER_MINUTE: z.string().transform(Number).pipe(z.number().int().positive()).default('30'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ENABLE_TOKEN_METRICS: z.string().transform((val) => val === 'true').default('true'),
  MODERATION_API_KEY: z.string().optional(),
  MODERATION_API_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);
