import pinoModule from 'pino';
import { config } from '../config/index.js';

// Pino types (fixes NodeNext ESM/CJS interop)
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface PinoOptions {
  level?: string;
  transport?: {
    target: string;
    options?: Record<string, unknown>;
  };
  base?: Record<string, unknown>;
}

// Fix ESM/CJS interop at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pino = ((pinoModule as any).default ?? pinoModule) as (opts?: PinoOptions) => Logger;

const isDevelopment = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    pid: false,
  },
});

export const createChildLogger = (context: Record<string, unknown>): Logger => {
  return logger.child(context);
};
