import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal, TRADING } from '../utils/constants.js';
import type {
  Position,
  PositionBatch,
  SellMode,
  CreatePositionInput,
  BatchSummary,
  SellCheckResult,
} from '../types/index.js';

type DecimalType = InstanceType<typeof Decimal>;

const logger = createChildLogger({ service: 'PositionManager' });

export class PositionManagerService {
  // ============================================
  // BATCH OPERATIONS
  // ============================================

  /**
   * Busca o batch ativo para o símbolo
   */
  async getActiveBatch(symbol: string): Promise<PositionBatch | null> {
    return prisma.positionBatch.findFirst({
      where: { symbol, status: 'ACTIVE' },
      include: { positions: { where: { status: 'OPEN' } } },
    });
  }

  /**
   * Cria um novo batch
   */
  async createBatch(
    symbol: string,
    sellMode: SellMode,
    initialPrice: DecimalType
  ): Promise<PositionBatch> {
    const nextBuyPrice = initialPrice; // Primeira compra imediata
    const targetSellPrice = initialPrice.times(TRADING.SELL_TARGET_MULTIPLIER);

    const batch = await prisma.positionBatch.create({
      data: {
        symbol,
        sellMode,
        totalQuantity: 0,
        totalInvested: 0,
        averagePrice: 0,
        nextBuyPrice: nextBuyPrice.toNumber(),
        targetSellPrice: targetSellPrice.toNumber(),
      },
    });

    logger.info(
      {
        batchId: batch.id,
        symbol,
        sellMode,
        nextBuyPrice: nextBuyPrice.toString(),
      },
      'New batch created'
    );

    return batch;
  }

  /**
   * Adiciona uma posição ao batch e recalcula médias
   */
  async addPosition(
    batchId: string,
    input: CreatePositionInput,
    orderId?: string,
    fee?: { cost: number; currency: string }
  ): Promise<Position> {
    return prisma.$transaction(async (tx) => {
      // 1. Criar position
      const position = await tx.position.create({
        data: {
          symbol: input.symbol,
          side: 'buy',
          quantity: input.quantity.toNumber(),
          entryPrice: input.entryPrice.toNumber(),
          investedAmount: input.investedAmount.toNumber(),
          orderId,
          fee: fee?.cost,
          feeCurrency: fee?.currency,
          batchId,
        },
      });

      logger.info(
        {
          positionId: position.id,
          batchId,
          quantity: input.quantity.toString(),
          entryPrice: input.entryPrice.toString(),
          invested: input.investedAmount.toString(),
        },
        'Position created'
      );

      // 2. Recalcular batch
      await this.recalculateBatchInTransaction(tx, batchId, input.entryPrice);

      return position;
    });
  }

  /**
   * Recalcula os valores agregados do batch (preço médio ponderado, targets)
   */
  private async recalculateBatchInTransaction(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    batchId: string,
    lastEntryPrice: DecimalType
  ): Promise<void> {
    const openPositions = await tx.position.findMany({
      where: { batchId, status: 'OPEN' },
    });

    if (openPositions.length === 0) {
      return;
    }

    // Calcular totais
    let totalInvested = new Decimal(0);
    let totalQuantity = new Decimal(0);

    for (const pos of openPositions) {
      totalInvested = totalInvested.plus(pos.investedAmount.toString());
      totalQuantity = totalQuantity.plus(pos.quantity.toString());
    }

    // Preço médio PONDERADO: totalInvested / totalQuantity
    const averagePrice = totalInvested.dividedBy(totalQuantity);

    // Próximo preço de compra: lastEntryPrice * 0.97
    const dropPercent = new Decimal(config.DCA_DROP_PERCENT);
    const nextBuyPrice = lastEntryPrice.times(new Decimal(1).minus(dropPercent));

    // Target de venda: averagePrice * 1.03
    const profitTarget = new Decimal(config.DCA_PROFIT_TARGET);
    const targetSellPrice = averagePrice.times(new Decimal(1).plus(profitTarget));

    await tx.positionBatch.update({
      where: { id: batchId },
      data: {
        totalQuantity: totalQuantity.toNumber(),
        totalInvested: totalInvested.toNumber(),
        averagePrice: averagePrice.toNumber(),
        nextBuyPrice: nextBuyPrice.toNumber(),
        targetSellPrice: targetSellPrice.toNumber(),
      },
    });

    logger.info(
      {
        batchId,
        positionCount: openPositions.length,
        totalInvested: totalInvested.toString(),
        totalQuantity: totalQuantity.toString(),
        averagePrice: averagePrice.toString(),
        nextBuyPrice: nextBuyPrice.toString(),
        targetSellPrice: targetSellPrice.toString(),
      },
      'Batch recalculated'
    );
  }

  /**
   * Recalcula o batch (versão pública, sem transaction)
   */
  async recalculateBatch(batchId: string): Promise<void> {
    const batch = await prisma.positionBatch.findUnique({
      where: { id: batchId },
      include: { positions: { where: { status: 'OPEN' } } },
    });

    if (!batch || batch.positions.length === 0) {
      return;
    }

    const lastPosition = batch.positions[batch.positions.length - 1];
    const lastEntryPrice = new Decimal(lastPosition.entryPrice.toString());

    await prisma.$transaction(async (tx) => {
      await this.recalculateBatchInTransaction(tx, batchId, lastEntryPrice);
    });
  }

  // ============================================
  // SELL LOGIC
  // ============================================

  /**
   * Verifica se deve vender baseado no modo configurado
   */
  async checkSellCondition(
    batch: PositionBatch,
    currentPrice: DecimalType
  ): Promise<SellCheckResult> {
    const sellMode = batch.sellMode;

    switch (sellMode) {
      case 'BATCH':
        return this.checkBatchSell(batch, currentPrice);
      case 'INDIVIDUAL':
        return this.checkIndividualSell(batch, currentPrice);
      case 'HYBRID':
        return this.checkHybridSell(batch, currentPrice);
      default:
        return { shouldSell: false, mode: 'none', positionsToSell: [] };
    }
  }

  /**
   * BATCH MODE: Vende todas quando preço >= averagePrice * 1.03
   */
  private async checkBatchSell(
    batch: PositionBatch,
    currentPrice: DecimalType
  ): Promise<SellCheckResult> {
    const targetPrice = new Decimal(batch.targetSellPrice.toString());

    if (currentPrice.lessThan(targetPrice)) {
      return { shouldSell: false, mode: 'none', positionsToSell: [] };
    }

    const positions = await prisma.position.findMany({
      where: { batchId: batch.id, status: 'OPEN' },
    });

    logger.info(
      {
        batchId: batch.id,
        currentPrice: currentPrice.toString(),
        targetPrice: targetPrice.toString(),
        positionCount: positions.length,
      },
      'BATCH sell condition met'
    );

    return {
      shouldSell: true,
      mode: 'batch',
      positionsToSell: positions,
      reason: `Price ${currentPrice.toString()} >= target ${targetPrice.toString()}`,
    };
  }

  /**
   * INDIVIDUAL MODE: Cada posição com seu target (entryPrice * 1.03)
   */
  private async checkIndividualSell(
    batch: PositionBatch,
    currentPrice: DecimalType
  ): Promise<SellCheckResult> {
    const positions = await prisma.position.findMany({
      where: { batchId: batch.id, status: 'OPEN' },
    });

    const profitTarget = new Decimal(config.DCA_PROFIT_TARGET);
    const positionsToSell: Position[] = [];

    for (const position of positions) {
      const entryPrice = new Decimal(position.entryPrice.toString());
      const targetPrice = entryPrice.times(new Decimal(1).plus(profitTarget));

      if (currentPrice.greaterThanOrEqualTo(targetPrice)) {
        positionsToSell.push(position);
        logger.debug(
          {
            positionId: position.id,
            entryPrice: entryPrice.toString(),
            targetPrice: targetPrice.toString(),
          },
          'Individual position ready to sell'
        );
      }
    }

    if (positionsToSell.length === 0) {
      return { shouldSell: false, mode: 'none', positionsToSell: [] };
    }

    logger.info(
      {
        batchId: batch.id,
        readyCount: positionsToSell.length,
        totalCount: positions.length,
      },
      'INDIVIDUAL sell condition met'
    );

    return {
      shouldSell: true,
      mode: 'individual',
      positionsToSell,
      reason: `${positionsToSell.length} positions reached individual targets`,
    };
  }

  /**
   * HYBRID MODE: Prioriza individuais, depois verifica batch
   */
  private async checkHybridSell(
    batch: PositionBatch,
    currentPrice: DecimalType
  ): Promise<SellCheckResult> {
    // Passo 1: Verificar se há posições individuais prontas
    const individualResult = await this.checkIndividualSell(batch, currentPrice);

    if (individualResult.shouldSell) {
      return individualResult;
    }

    // Passo 2: Se não há individuais, verificar batch
    return this.checkBatchSell(batch, currentPrice);
  }

  /**
   * Fecha posições após venda
   */
  async closePositions(
    positions: Position[],
    exitPrice: DecimalType,
    exitOrderId?: string
  ): Promise<void> {
    const profitTarget = new Decimal(config.DCA_PROFIT_TARGET);

    await prisma.$transaction(async (tx) => {
      for (const position of positions) {
        const invested = new Decimal(position.investedAmount.toString());
        const quantity = new Decimal(position.quantity.toString());
        const saleValue = quantity.times(exitPrice);
        const profit = saleValue.minus(invested);
        const profitPercent = profit.dividedBy(invested).times(100);

        await tx.position.update({
          where: { id: position.id },
          data: {
            status: 'CLOSED',
            exitPrice: exitPrice.toNumber(),
            exitOrderId,
            profit: profit.toNumber(),
            profitPercent: profitPercent.toNumber(),
            closedAt: new Date(),
          },
        });

        logger.info(
          {
            positionId: position.id,
            exitPrice: exitPrice.toString(),
            profit: profit.toString(),
            profitPercent: profitPercent.toFixed(2) + '%',
          },
          'Position closed'
        );
      }
    });
  }

  /**
   * Fecha o batch quando todas as posições foram vendidas
   */
  async closeBatchIfEmpty(batchId: string): Promise<boolean> {
    const openCount = await prisma.position.count({
      where: { batchId, status: 'OPEN' },
    });

    if (openCount > 0) {
      // Recalcular batch com posições restantes
      await this.recalculateBatch(batchId);
      return false;
    }

    await prisma.positionBatch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        closedAt: new Date(),
      },
    });

    logger.info({ batchId }, 'Batch completed (all positions closed)');
    return true;
  }

  // ============================================
  // QUERIES
  // ============================================

  /**
   * Obtém resumo do batch atual
   */
  async getBatchSummary(batchId: string, currentPrice?: DecimalType): Promise<BatchSummary | null> {
    const batch = await prisma.positionBatch.findUnique({
      where: { id: batchId },
      include: { positions: { where: { status: 'OPEN' } } },
    });

    if (!batch) return null;

    const totalInvested = new Decimal(batch.totalInvested.toString());
    const totalQuantity = new Decimal(batch.totalQuantity.toString());
    const averagePrice = new Decimal(batch.averagePrice.toString());

    let currentPnL: DecimalType | undefined;
    let currentPnLPercent: DecimalType | undefined;

    if (currentPrice && totalQuantity.greaterThan(0)) {
      const currentValue = totalQuantity.times(currentPrice);
      currentPnL = currentValue.minus(totalInvested);
      currentPnLPercent = currentPnL.dividedBy(totalInvested).times(100);
    }

    return {
      id: batch.id,
      symbol: batch.symbol,
      sellMode: batch.sellMode,
      status: batch.status,
      positionCount: batch.positions.length,
      totalInvested,
      totalQuantity,
      averagePrice,
      nextBuyPrice: new Decimal(batch.nextBuyPrice.toString()),
      targetSellPrice: new Decimal(batch.targetSellPrice.toString()),
      currentPrice,
      currentPnL,
      currentPnLPercent,
    };
  }

  /**
   * Registra operação no log de trades
   */
  async logTrade(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: DecimalType,
    price: DecimalType,
    cost: DecimalType,
    context: {
      batchId?: string;
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
        batchId: context.batchId,
        positionId: context.positionId,
        reason: context.reason,
        rawResponse: context.rawResponse as object,
      },
    });
  }
}

// Export singleton
export const positionManager = new PositionManagerService();
