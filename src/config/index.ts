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
    .default('false'),

  // Trading (multi-pair)
  TRADING_SYMBOLS: z
    .string()
    .default('BTC/USDT')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),

  // Grid parameters
  GRID_DROP_PERCENT: z.coerce.number().min(0.01).max(0.5).default(0.03),
  GRID_DROP_PERCENT_HIGH_VOL: z.coerce.number().min(0.01).max(0.5).default(0.04),
  GRID_MAX_BUYS: z.coerce.number().int().min(1).max(20).default(4),
  GRID_PROFIT_TARGET: z.coerce.number().min(0.005).max(0.5).default(0.03),
  GRID_TRAILING_STOP_PERCENT: z.coerce.number().min(0.005).max(0.2).default(0.015),
  GRID_PARTIAL_SELL_PERCENT: z.coerce.number().min(0.1).max(1.0).default(0.50),

  // Capital management
  CAPITAL_MAX_EXPOSURE: z.coerce.number().min(0.05).max(1.0).default(0.30),
  CAPITAL_ENTRY_PERCENT: z.coerce.number().min(0.01).max(0.5).default(0.10),

  // Entry criteria
  ENTRY_RSI_THRESHOLD: z.coerce.number().min(10).max(70).default(40),
  ENTRY_RSI_RECOVERY: z.coerce.number().min(10).max(70).default(35),
  ENTRY_VOLUME_LOOKBACK: z.coerce.number().int().min(0).max(100).default(20),

  // Risk management
  RISK_MAX_DRAWDOWN: z.coerce.number().min(0.01).max(0.5).default(0.15),
  RISK_CRASH_DROP_PERCENT: z.coerce.number().min(0.03).max(0.3).default(0.08),
  RISK_CRASH_TIME_WINDOW_MINUTES: z.coerce.number().int().min(30).max(1440).default(240),
  RISK_LATERAL_CYCLE_COUNT: z.coerce.number().int().min(1).max(20).default(3),
  RISK_LATERAL_PROFIT_THRESHOLD: z.coerce.number().min(0.001).max(0.05).default(0.005),
  RISK_LATERAL_PAUSE_HOURS: z.coerce.number().min(1).max(168).default(24),

  // TaAPI.io
  TAAPI_SECRET: z.string().min(1),
  TAAPI_RATE_LIMIT: z.coerce.number().int().min(1).max(100).default(1),
  TAAPI_CACHE_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  TELEGRAM_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),

  // Intervals
  TICK_INTERVAL_MS: z.coerce.number().min(5000).default(60000),
  METRICS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

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
