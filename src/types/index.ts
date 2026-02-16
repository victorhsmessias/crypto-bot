import type {
  Cycle,
  Position,
  BotState,
  Metrics,
  CrashEvent,
  TradeLog,
  NotificationLog,
  CycleStatus,
  PositionStatus,
  BotStateType,
  NotificationType,
} from '@prisma/client';
import type { Decimal } from '../utils/constants.js';

// Re-export Prisma types
export type {
  Cycle,
  Position,
  BotState,
  Metrics,
  CrashEvent,
  TradeLog,
  NotificationLog,
  CycleStatus,
  PositionStatus,
  BotStateType,
  NotificationType,
};

// ============================================
// INDICATORS
// ============================================

export interface IndicatorSnapshot {
  rsi15m: number | null;
  rsi1h: number | null;
  ema200_4h: number | null;
  atr14_4h: number | null;
  volumeRatio: number | null;
  fetchedAt: Date;
}

export interface EntryEvaluation {
  canEnter: boolean;
  reasons: string[];
  indicators: IndicatorSnapshot;
}

// ============================================
// TICK CONTEXT
// ============================================

export interface TickContext {
  symbol: string;
  currentPrice: Decimal;
  indicators: IndicatorSnapshot;
  cycle: Cycle | null;
  botState: BotState;
  availableBalance: Decimal;
  totalBalance: Decimal;
  timestamp: Date;
}

// ============================================
// STRATEGY
// ============================================

export type StrategyAction =
  | { type: 'WAIT'; reason: string }
  | { type: 'OPEN_CYCLE'; reason: string }
  | { type: 'DCA_BUY'; reason: string; buyNumber: number }
  | { type: 'PARTIAL_SELL'; reason: string; sellPercent: number }
  | { type: 'TRAILING_SELL'; reason: string }
  | { type: 'FULL_CLOSE'; reason: string }
  | { type: 'UPDATE_TRAILING'; newStopPrice: Decimal };

// ============================================
// ORDERS
// ============================================

export interface OrderResult {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  price: number;
  amount: number;
  filled: number;
  remaining: number;
  cost: number;
  fee?: { cost: number; currency: string };
  timestamp: number;
  slippage?: number;
}

// ============================================
// POSITION INPUT
// ============================================

export interface CreatePositionInput {
  symbol: string;
  quantity: Decimal;
  entryPrice: Decimal;
  investedAmount: Decimal;
  buyNumber: number;
}

// ============================================
// CYCLE SUMMARY
// ============================================

export interface CycleSummary {
  id: string;
  symbol: string;
  status: CycleStatus;
  buyCount: number;
  maxBuys: number;
  totalInvested: Decimal;
  totalQuantity: Decimal;
  remainingQuantity: Decimal;
  averagePrice: Decimal;
  nextBuyPrice: Decimal;
  targetSellPrice: Decimal;
  gridPercent: Decimal;
  partialSellDone: boolean;
  trailingStopPrice: Decimal | null;
  trailingHighPrice: Decimal | null;
  currentPrice?: Decimal;
  currentPnL?: Decimal;
  currentPnLPercent?: Decimal;
}

// ============================================
// NOTIFICATIONS
// ============================================

export interface NotificationPayload {
  type: NotificationType;
  symbol?: string;
  message: string;
  data?: Record<string, unknown>;
}

// ============================================
// METRICS
// ============================================

export interface PerformanceSummary {
  totalCycles: number;
  winRate: Decimal;
  netProfit: Decimal;
  maxDrawdown: Decimal;
  avgCycleDurationMinutes: number;
  maxExposureHit: Decimal;
}
