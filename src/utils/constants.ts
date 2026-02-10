import Decimal from 'decimal.js';

// Configurar precisão do Decimal.js
Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

export const TRADING = {
  // Percentuais padrão (podem ser sobrescritos pelo config)
  DEFAULT_DROP_PERCENT: new Decimal('0.03'),
  DEFAULT_POSITION_SIZE: new Decimal('0.10'),
  DEFAULT_PROFIT_TARGET: new Decimal('0.03'),

  // Limites
  MIN_ORDER_VALUE_USDT: new Decimal('10'),
  MAX_POSITIONS_PER_BATCH: 100,

  // Multiplicadores
  BUY_TRIGGER_MULTIPLIER: new Decimal('0.97'),   // 1 - 0.03
  SELL_TARGET_MULTIPLIER: new Decimal('1.03'),   // 1 + 0.03
} as const;

export const EXCHANGE = {
  DEFAULT_TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
} as const;
