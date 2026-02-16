import DecimalJS from 'decimal.js';

// Decimal instance type (fixes NodeNext ESM/CJS interop)
export interface Decimal {
  toString(): string;
  toNumber(): number;
  toFixed(dp?: number): string;
  plus(n: string | number | Decimal): Decimal;
  minus(n: string | number | Decimal): Decimal;
  times(n: string | number | Decimal): Decimal;
  dividedBy(n: string | number | Decimal): Decimal;
  greaterThan(n: string | number | Decimal): boolean;
  greaterThanOrEqualTo(n: string | number | Decimal): boolean;
  lessThan(n: string | number | Decimal): boolean;
  lessThanOrEqualTo(n: string | number | Decimal): boolean;
  equals(n: string | number | Decimal): boolean;
  isZero(): boolean;
  isPositive(): boolean;
  isNegative(): boolean;
  abs(): Decimal;
}

interface DecimalConstructor {
  new (value: string | number | Decimal): Decimal;
  set(config: { precision?: number; rounding?: number }): void;
  ROUND_DOWN: number;
}

// Fix ESM/CJS interop at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Decimal: DecimalConstructor = (DecimalJS as any).default ?? DecimalJS;

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

export const EXCHANGE = {
  DEFAULT_TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  MIN_ORDER_VALUE_USDT: new Decimal('10'),
} as const;

export const ATR_HIGH_VOL_THRESHOLD = new Decimal('0.02');
