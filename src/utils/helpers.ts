import { Decimal } from './constants.js';
import type { Decimal as DecimalType } from './constants.js';
import type { Logger } from './logger.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
  logger: Logger,
  context: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const backoff = delayMs * Math.pow(2, attempt - 1);
        logger.warn(
          { attempt, maxRetries, backoffMs: backoff, context },
          'Retrying after failure'
        );
        await sleep(backoff);
      }
    }
  }

  throw lastError;
}

export function percentChange(from: DecimalType, to: DecimalType): DecimalType {
  if (from.isZero()) return new Decimal(0);
  return to.minus(from).dividedBy(from);
}
