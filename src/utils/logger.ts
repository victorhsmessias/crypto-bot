import pinoModule from 'pino';

// Fix ESM import
const pino = (pinoModule as unknown as { default: typeof pinoModule }).default || pinoModule;

const isDevelopment = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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

export const createChildLogger = (context: Record<string, unknown>) => {
  return logger.child(context);
};
