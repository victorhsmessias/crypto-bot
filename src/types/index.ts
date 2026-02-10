import type { Decimal } from 'decimal.js';
import type {
  Position,
  PositionBatch,
  SellMode,
  PositionStatus,
  BatchStatus,
} from '@prisma/client';

// Re-export Prisma types
export type { Position, PositionBatch, SellMode, PositionStatus, BatchStatus };

// Input types
export interface CreatePositionInput {
  symbol: string;
  quantity: Decimal;
  entryPrice: Decimal;
  investedAmount: Decimal;
}

export interface CreateBatchInput {
  symbol: string;
  sellMode: SellMode;
  initialPrice: Decimal;
}

// Result types
export interface TradeResult {
  success: boolean;
  orderId?: string;
  executedPrice?: Decimal;
  executedQuantity?: Decimal;
  fee?: Decimal;
  error?: string;
}

export interface BatchSummary {
  id: string;
  symbol: string;
  sellMode: SellMode;
  status: BatchStatus;
  positionCount: number;
  totalInvested: Decimal;
  totalQuantity: Decimal;
  averagePrice: Decimal;
  nextBuyPrice: Decimal;
  targetSellPrice: Decimal;
  currentPrice?: Decimal;
  currentPnL?: Decimal;
  currentPnLPercent?: Decimal;
}

export interface PositionWithTarget extends Position {
  targetPrice: Decimal;
  currentPnL?: Decimal;
  currentPnLPercent?: Decimal;
}

// Order types
export interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  amount: number;
  price?: number;
}

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
  fee?: {
    cost: number;
    currency: string;
  };
  timestamp: number;
}

// Strategy types
export interface TickContext {
  currentPrice: Decimal;
  batch: PositionBatch | null;
  availableBalance: Decimal;
  timestamp: Date;
}

export interface StrategyDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  reason: string;
  params?: {
    amount?: Decimal;
    positions?: Position[];
  };
}

// Sell check result
export interface SellCheckResult {
  shouldSell: boolean;
  mode: 'batch' | 'individual' | 'none';
  positionsToSell: Position[];
  reason?: string;
}
