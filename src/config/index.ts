import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Exchange
  EXCHANGE_API_KEY: z.string().min(1),
  EXCHANGE_API_SECRET: z.string().min(1),
  EXCHANGE_SANDBOX: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),

  // Trading
  TRADING_SYMBOL: z.string().default('BTC/USDT'),
  TRADING_SELL_MODE: z
    .enum(['BATCH', 'INDIVIDUAL', 'HYBRID'])
    .default('BATCH'),

  // DCA Parameters
  DCA_DROP_PERCENT: z.coerce
    .number()
    .min(0.01)
    .max(0.5)
    .default(0.03),
  DCA_POSITION_SIZE: z.coerce
    .number()
    .min(0.01)
    .max(1)
    .default(0.1),
  DCA_PROFIT_TARGET: z.coerce
    .number()
    .min(0.01)
    .max(0.5)
    .default(0.03),

  // Intervals
  TICK_INTERVAL_MS: z.coerce.number().min(1000).default(5000),

  // Logging
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;
