import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import type {
  Cycle,
  Position,
  CycleStatus,
  IndicatorSnapshot,
  CreatePositionInput,
  CycleSummary,
} from '../types/index.js';

const logger = createChildLogger({ service: 'PositionManager' });

export class PositionManagerService {
  // ============================================
  // CYCLE OPERATIONS
  // ============================================

  async getActiveCycle(symbol: string): Promise<Cycle | null> {
    return prisma.cycle.findFirst({
      where: {
        symbol,
        status: { in: ['ACTIVE', 'PARTIAL_SELL', 'TRAILING', 'PAUSED'] },
      },
      include: { positions: { where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } } } },
    });
  }

  async createCycle(
    symbol: string,
    totalBalance: DecimalType,
    indicators: IndicatorSnapshot,
    gridPercent: number
  ): Promise<Cycle> {
    const maxExposure = totalBalance.times(new Decimal(config.CAPITAL_MAX_EXPOSURE));

    const cycle = await prisma.cycle.create({
      data: {
        symbol,
        status: 'ACTIVE',
        initialBalance: totalBalance.toNumber(),
        maxExposure: maxExposure.toNumber(),
        gridPercent,
        entryPercent: config.CAPITAL_ENTRY_PERCENT,
        maxBuys: config.GRID_MAX_BUYS,
        entryRsi: indicators.rsi15m ?? indicators.rsi1h ?? undefined,
        entryEma200: indicators.ema200_4h ?? undefined,
        entryAtr: indicators.atr14_4h ?? undefined,
      },
    });

    logger.info(
      {
        cycleId: cycle.id,
        symbol,
        maxExposure: maxExposure.toString(),
        gridPercent,
      },
      'New cycle created'
    );

    return cycle;
  }

  async updateCycleStatus(cycleId: string, status: CycleStatus): Promise<void> {
    await prisma.cycle.update({
      where: { id: cycleId },
      data: {
        status,
        ...(status === 'COMPLETED' ? { closedAt: new Date() } : {}),
      },
    });
    logger.info({ cycleId, status }, 'Cycle status updated');
  }

  // ============================================
  // POSITION OPERATIONS
  // ============================================

  async addPosition(
    cycleId: string,
    input: CreatePositionInput,
    orderId?: string,
    fee?: { cost: number; currency: string }
  ): Promise<Position> {
    return prisma.$transaction(async (tx) => {
      const position = await tx.position.create({
        data: {
          symbol: input.symbol,
          side: 'buy',
          quantity: input.quantity.toNumber(),
          remainingQuantity: input.quantity.toNumber(),
          entryPrice: input.entryPrice.toNumber(),
          investedAmount: input.investedAmount.toNumber(),
          buyNumber: input.buyNumber,
          orderId,
          fee: fee?.cost,
          feeCurrency: fee?.currency,
          cycleId,
        },
      });

      logger.info(
        {
          positionId: position.id,
          cycleId,
          buyNumber: input.buyNumber,
          quantity: input.quantity.toString(),
          entryPrice: input.entryPrice.toString(),
          invested: input.investedAmount.toString(),
        },
        'Position created'
      );

      await this.recalculateCycleInTransaction(tx, cycleId, input.entryPrice);

      return position;
    });
  }

  async getOpenPositionCount(cycleId: string): Promise<number> {
    return prisma.position.count({
      where: { cycleId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
    });
  }

  // ============================================
  // RECALCULATE CYCLE
  // ============================================

  private async recalculateCycleInTransaction(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    cycleId: string,
    lastEntryPrice?: DecimalType
  ): Promise<void> {
    const positions = await tx.position.findMany({
      where: { cycleId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
    });

    if (positions.length === 0) return;

    let totalInvested = new Decimal(0);
    let totalQuantity = new Decimal(0);
    let remainingQuantity = new Decimal(0);

    for (const pos of positions) {
      totalInvested = totalInvested.plus(pos.investedAmount.toString());
      totalQuantity = totalQuantity.plus(pos.quantity.toString());
      remainingQuantity = remainingQuantity.plus(pos.remainingQuantity.toString());
    }

    const averagePrice = totalQuantity.isZero()
      ? new Decimal(0)
      : totalInvested.dividedBy(totalQuantity);

    const cycle = await tx.cycle.findUnique({ where: { id: cycleId } });
    if (!cycle) return;

    const gridPercent = new Decimal(cycle.gridPercent.toString());
    const profitTarget = new Decimal(config.GRID_PROFIT_TARGET);

    const entryPrice = lastEntryPrice ?? averagePrice;
    const nextBuyPrice = entryPrice.times(new Decimal(1).minus(gridPercent));
    const targetSellPrice = averagePrice.times(new Decimal(1).plus(profitTarget));

    await tx.cycle.update({
      where: { id: cycleId },
      data: {
        totalQuantity: totalQuantity.toNumber(),
        remainingQuantity: remainingQuantity.toNumber(),
        totalInvested: totalInvested.toNumber(),
        averagePrice: averagePrice.toNumber(),
        nextBuyPrice: nextBuyPrice.toNumber(),
        targetSellPrice: targetSellPrice.toNumber(),
        buyCount: positions.length,
      },
    });

    logger.info(
      {
        cycleId,
        buyCount: positions.length,
        totalInvested: totalInvested.toString(),
        totalQuantity: totalQuantity.toString(),
        averagePrice: averagePrice.toString(),
        nextBuyPrice: nextBuyPrice.toString(),
        targetSellPrice: targetSellPrice.toString(),
      },
      'Cycle recalculated'
    );
  }

  async recalculateCycle(cycleId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.recalculateCycleInTransaction(tx, cycleId);
    });
  }

  // ============================================
  // PARTIAL SELL (50%)
  // ============================================

  async partialClosePositions(
    cycleId: string,
    sellPercent: DecimalType,
    exitPrice: DecimalType,
    exitOrderId?: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const positions = await tx.position.findMany({
        where: { cycleId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
      });

      for (const position of positions) {
        const remaining = new Decimal(position.remainingQuantity.toString());
        const soldQuantity = remaining.times(sellPercent);
        const newRemaining = remaining.minus(soldQuantity);

        await tx.position.update({
          where: { id: position.id },
          data: {
            remainingQuantity: newRemaining.toNumber(),
            status: newRemaining.isZero() ? 'CLOSED' : 'PARTIALLY_CLOSED',
            ...(newRemaining.isZero() ? {
              exitPrice: exitPrice.toNumber(),
              exitOrderId,
              closedAt: new Date(),
            } : {}),
          },
        });

        logger.debug(
          {
            positionId: position.id,
            soldQuantity: soldQuantity.toString(),
            newRemaining: newRemaining.toString(),
          },
          'Position partially closed'
        );
      }

      // Update cycle remaining quantity
      const totalRemaining = positions.reduce(
        (sum, p) => {
          const r = new Decimal(p.remainingQuantity.toString());
          return sum.plus(r.minus(r.times(sellPercent)));
        },
        new Decimal(0)
      );

      await tx.cycle.update({
        where: { id: cycleId },
        data: {
          remainingQuantity: totalRemaining.toNumber(),
          partialSellDone: true,
          status: 'PARTIAL_SELL',
        },
      });
    });

    logger.info(
      { cycleId, sellPercent: sellPercent.toString(), exitPrice: exitPrice.toString() },
      'Partial close executed'
    );
  }

  // ============================================
  // FULL CLOSE
  // ============================================

  async fullClosePositions(
    cycleId: string,
    exitPrice: DecimalType,
    exitOrderId?: string
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const positions = await tx.position.findMany({
        where: { cycleId, status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
      });

      let totalInvested = new Decimal(0);
      let totalSaleValue = new Decimal(0);

      for (const position of positions) {
        const invested = new Decimal(position.investedAmount.toString());
        const remaining = new Decimal(position.remainingQuantity.toString());
        const saleValue = remaining.times(exitPrice);
        const profit = saleValue.minus(invested);
        const profitPct = invested.isZero() ? new Decimal(0) : profit.dividedBy(invested).times(100);

        totalInvested = totalInvested.plus(invested);
        totalSaleValue = totalSaleValue.plus(saleValue);

        await tx.position.update({
          where: { id: position.id },
          data: {
            status: 'CLOSED',
            remainingQuantity: 0,
            exitPrice: exitPrice.toNumber(),
            exitOrderId,
            profit: profit.toNumber(),
            profitPercent: profitPct.toNumber(),
            closedAt: new Date(),
          },
        });
      }

      const totalProfit = totalSaleValue.minus(totalInvested);
      const totalProfitPct = totalInvested.isZero()
        ? new Decimal(0)
        : totalProfit.dividedBy(totalInvested).times(100);

      await tx.cycle.update({
        where: { id: cycleId },
        data: {
          status: 'COMPLETED',
          remainingQuantity: 0,
          totalProfit: totalProfit.toNumber(),
          profitPercent: totalProfitPct.toNumber(),
          closedAt: new Date(),
        },
      });

      logger.info(
        {
          cycleId,
          totalProfit: totalProfit.toString(),
          profitPercent: totalProfitPct.toFixed(2) + '%',
        },
        'Cycle fully closed'
      );
    });
  }

  // ============================================
  // TRAILING STOP
  // ============================================

  async activateTrailingStop(
    cycleId: string,
    currentPrice: DecimalType,
    trailingPercent: DecimalType
  ): Promise<void> {
    const stopPrice = currentPrice.times(new Decimal(1).minus(trailingPercent));

    await prisma.cycle.update({
      where: { id: cycleId },
      data: {
        status: 'TRAILING',
        trailingHighPrice: currentPrice.toNumber(),
        trailingStopPrice: stopPrice.toNumber(),
      },
    });

    logger.info(
      {
        cycleId,
        highPrice: currentPrice.toString(),
        stopPrice: stopPrice.toString(),
        trailingPercent: trailingPercent.toString(),
      },
      'Trailing stop activated'
    );
  }

  async updateTrailingStop(
    cycleId: string,
    currentPrice: DecimalType
  ): Promise<{ triggered: boolean; stopPrice: DecimalType }> {
    const cycle = await prisma.cycle.findUnique({ where: { id: cycleId } });
    if (!cycle || !cycle.trailingStopPrice || !cycle.trailingHighPrice) {
      return { triggered: false, stopPrice: new Decimal(0) };
    }

    const trailingPercent = new Decimal(config.GRID_TRAILING_STOP_PERCENT);
    let highPrice = new Decimal(cycle.trailingHighPrice.toString());
    let stopPrice = new Decimal(cycle.trailingStopPrice.toString());

    // Update high watermark
    if (currentPrice.greaterThan(highPrice)) {
      highPrice = currentPrice;
      stopPrice = currentPrice.times(new Decimal(1).minus(trailingPercent));

      await prisma.cycle.update({
        where: { id: cycleId },
        data: {
          trailingHighPrice: highPrice.toNumber(),
          trailingStopPrice: stopPrice.toNumber(),
        },
      });

      logger.debug(
        {
          cycleId,
          newHigh: highPrice.toString(),
          newStop: stopPrice.toString(),
        },
        'Trailing stop moved up'
      );
    }

    // Check if triggered
    if (currentPrice.lessThanOrEqualTo(stopPrice)) {
      logger.info(
        {
          cycleId,
          currentPrice: currentPrice.toString(),
          stopPrice: stopPrice.toString(),
        },
        'Trailing stop triggered'
      );
      return { triggered: true, stopPrice };
    }

    return { triggered: false, stopPrice };
  }

  // ============================================
  // QUERIES
  // ============================================

  async getCycleSummary(cycleId: string, currentPrice?: DecimalType): Promise<CycleSummary | null> {
    const cycle = await prisma.cycle.findUnique({
      where: { id: cycleId },
      include: { positions: { where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } } } },
    });

    if (!cycle) return null;

    const totalInvested = new Decimal(cycle.totalInvested.toString());
    const remainingQuantity = new Decimal(cycle.remainingQuantity.toString());

    let currentPnL: DecimalType | undefined;
    let currentPnLPercent: DecimalType | undefined;

    if (cycle.status === 'COMPLETED' && cycle.totalProfit !== null) {
      // Ciclo fechado: usar valores persistidos
      currentPnL = new Decimal(cycle.totalProfit.toString());
      currentPnLPercent = cycle.profitPercent
        ? new Decimal(cycle.profitPercent.toString())
        : new Decimal(0);
    } else if (currentPrice && remainingQuantity.greaterThan(0)) {
      // Ciclo ativo: calcular PnL em tempo real
      const currentValue = remainingQuantity.times(currentPrice);
      currentPnL = currentValue.minus(totalInvested);
      currentPnLPercent = totalInvested.isZero()
        ? new Decimal(0)
        : currentPnL.dividedBy(totalInvested).times(100);
    }

    return {
      id: cycle.id,
      symbol: cycle.symbol,
      status: cycle.status,
      buyCount: cycle.buyCount,
      maxBuys: cycle.maxBuys,
      totalInvested,
      totalQuantity: new Decimal(cycle.totalQuantity.toString()),
      remainingQuantity,
      averagePrice: new Decimal(cycle.averagePrice.toString()),
      nextBuyPrice: new Decimal(cycle.nextBuyPrice.toString()),
      targetSellPrice: new Decimal(cycle.targetSellPrice.toString()),
      gridPercent: new Decimal(cycle.gridPercent.toString()),
      partialSellDone: cycle.partialSellDone,
      trailingStopPrice: cycle.trailingStopPrice ? new Decimal(cycle.trailingStopPrice.toString()) : null,
      trailingHighPrice: cycle.trailingHighPrice ? new Decimal(cycle.trailingHighPrice.toString()) : null,
      currentPrice,
      currentPnL,
      currentPnLPercent,
    };
  }

  async getRecentCompletedCycles(symbol: string, count: number): Promise<Cycle[]> {
    return prisma.cycle.findMany({
      where: { symbol, status: 'COMPLETED' },
      orderBy: { closedAt: 'desc' },
      take: count,
    });
  }

  async logTrade(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: DecimalType,
    price: DecimalType,
    cost: DecimalType,
    context: {
      cycleId?: string;
      positionId?: string;
      reason?: string;
      orderId?: string;
      rawResponse?: unknown;
    }
  ): Promise<void> {
    await prisma.tradeLog.create({
      data: {
        symbol,
        side,
        quantity: quantity.toNumber(),
        price: price.toNumber(),
        cost: cost.toNumber(),
        orderId: context.orderId,
        cycleId: context.cycleId,
        positionId: context.positionId,
        reason: context.reason,
        rawResponse: context.rawResponse as object,
      },
    });
  }
}

export const positionManager = new PositionManagerService();
