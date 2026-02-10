import type {
  Position,
  PositionBatch,
  SellMode,
  PositionStatus,
  BatchStatus,
} from '@prisma/client';
import { Decimal } from '../utils/constants.js';

type DecimalType = InstanceType<typeof Decimal>;

// Re-export Prisma types
export type { Position, PositionBatch, SellMode, PositionStatus, BatchStatus };

// Input types
export interface CreatePositionInput {
  symbol: string;
  quantity: DecimalType;
  entryPrice: DecimalType;
  investedAmount: DecimalType;
}

export interface CreateBatchInput {
  symbol: string;
  sellMode: SellMode;
  initialPrice: DecimalType;
}

// Result types
export interface TradeResult {
  success: boolean;
  orderId?: string;
  executedPrice?: DecimalType;
  executedQuantity?: DecimalType;
  fee?: DecimalType;
  error?: string;
}

export interface BatchSummary {
  id: string;
  symbol: string;
  sellMode: SellMode;
  status: BatchStatus;
  positionCount: number;
  totalInvested: DecimalType;
  totalQuantity: DecimalType;
  averagePrice: DecimalType;
  nextBuyPrice: DecimalType;
  targetSellPrice: DecimalType;
  currentPrice?: DecimalType;
  currentPnL?: DecimalType;
  currentPnLPercent?: DecimalType;
}

export interface PositionWithTarget extends Position {
  targetPrice: DecimalType;
  currentPnL?: DecimalType;
  currentPnLPercent?: DecimalType;
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
  currentPrice: DecimalType;
  batch: PositionBatch | null;
  availableBalance: DecimalType;
  timestamp: Date;
}

export interface StrategyDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  reason: string;
  params?: {
    amount?: DecimalType;
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
