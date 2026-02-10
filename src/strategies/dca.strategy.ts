import Decimal from 'decimal.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { exchangeService } from '../services/exchange.service.js';
import { capitalManager } from '../services/capital-manager.service.js';
import { positionManager } from '../services/position-manager.service.js';
import type { PositionBatch, SellMode } from '../types/index.js';

const logger = createChildLogger({ service: 'DCAStrategy' });

export class DCAStrategy {
  private symbol: string;
  private sellMode: SellMode;
  private isRunning = false;

  constructor() {
    this.symbol = config.TRADING_SYMBOL;
    this.sellMode = config.TRADING_SELL_MODE as SellMode;
  }

  /**
   * Executa um tick da estratégia
   */
  async tick(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Previous tick still running, skipping');
      return;
    }

    this.isRunning = true;

    try {
      // 1. Obter preço atual
      const currentPrice = await exchangeService.getCurrentPrice(this.symbol);

      // 2. Obter ou criar batch ativo
      let batch = await positionManager.getActiveBatch(this.symbol);

      if (!batch) {
        // Primeiro tick - criar batch e compra inicial
        batch = await this.initializeBatch(currentPrice);
        await this.executeBuy(batch, currentPrice, 'INITIAL_BUY');
        this.isRunning = false;
        return;
      }

      // 3. Verificar condição de venda
      const sellCheck = await positionManager.checkSellCondition(batch, currentPrice);

      if (sellCheck.shouldSell) {
        await this.executeSell(batch, currentPrice, sellCheck.positionsToSell);

        // Verificar se batch ficou vazio
        const batchClosed = await positionManager.closeBatchIfEmpty(batch.id);

        if (batchClosed) {
          // Criar novo batch com compra inicial
          const newBatch = await this.initializeBatch(currentPrice);
          await this.executeBuy(newBatch, currentPrice, 'INITIAL_BUY');
        }

        this.isRunning = false;
        return;
      }

      // 4. Verificar condição de compra DCA
      const nextBuyPrice = new Decimal(batch.nextBuyPrice.toString());

      if (currentPrice.lessThanOrEqualTo(nextBuyPrice)) {
        await this.executeBuy(batch, currentPrice, 'DCA_BUY');
      } else {
        // Log de status
        this.logStatus(batch, currentPrice);
      }
    } catch (error) {
      logger.error({ error }, 'Error in strategy tick');
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Inicializa um novo batch
   */
  private async initializeBatch(currentPrice: Decimal): Promise<PositionBatch> {
    logger.info(
      { symbol: this.symbol, sellMode: this.sellMode },
      'Initializing new batch'
    );

    return positionManager.createBatch(this.symbol, this.sellMode, currentPrice);
  }

  /**
   * Executa uma compra
   */
  private async executeBuy(
    batch: PositionBatch,
    currentPrice: Decimal,
    reason: string
  ): Promise<void> {
    // Validar se pode comprar
    const buyCheck = await capitalManager.canExecuteBuy();

    if (!buyCheck.canBuy) {
      logger.warn({ reason: buyCheck.reason }, 'Cannot execute buy');
      return;
    }

    const amountToInvest = buyCheck.amount!;

    logger.info(
      {
        batchId: batch.id,
        amount: amountToInvest.toString(),
        price: currentPrice.toString(),
        reason,
      },
      'Executing buy order'
    );

    try {
      // Executar ordem na exchange
      const order = await exchangeService.createMarketBuyOrder(
        this.symbol,
        amountToInvest.toNumber()
      );

      // Calcular valores da posição
      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const investedAmount = new Decimal(order.cost);

      // Adicionar posição ao batch
      await positionManager.addPosition(
        batch.id,
        {
          symbol: this.symbol,
          quantity: executedQuantity,
          entryPrice: executedPrice,
          investedAmount,
        },
        order.id,
        order.fee
      );

      // Registrar no log de trades
      await positionManager.logTrade(
        this.symbol,
        'buy',
        executedQuantity,
        executedPrice,
        investedAmount,
        {
          batchId: batch.id,
          reason,
          orderId: order.id,
        }
      );

      logger.info(
        {
          orderId: order.id,
          price: executedPrice.toString(),
          quantity: executedQuantity.toString(),
          cost: investedAmount.toString(),
        },
        'Buy executed successfully'
      );
    } catch (error) {
      logger.error({ error, batchId: batch.id }, 'Buy execution failed');
      throw error;
    }
  }

  /**
   * Executa uma venda
   */
  private async executeSell(
    batch: PositionBatch,
    currentPrice: Decimal,
    positionsToSell: PositionBatch['positions']
  ): Promise<void> {
    // Calcular quantidade total a vender
    let totalQuantity = new Decimal(0);
    for (const pos of positionsToSell) {
      totalQuantity = totalQuantity.plus(pos.quantity.toString());
    }

    logger.info(
      {
        batchId: batch.id,
        positionCount: positionsToSell.length,
        totalQuantity: totalQuantity.toString(),
        currentPrice: currentPrice.toString(),
      },
      'Executing sell order'
    );

    try {
      // Executar ordem na exchange
      const order = await exchangeService.createMarketSellOrder(
        this.symbol,
        totalQuantity.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const saleValue = new Decimal(order.cost);

      // Fechar posições
      await positionManager.closePositions(
        positionsToSell,
        executedPrice,
        order.id
      );

      // Registrar no log de trades
      await positionManager.logTrade(
        this.symbol,
        'sell',
        executedQuantity,
        executedPrice,
        saleValue,
        {
          batchId: batch.id,
          reason: `${batch.sellMode}_SELL`,
          orderId: order.id,
        }
      );

      // Calcular lucro total
      let totalInvested = new Decimal(0);
      for (const pos of positionsToSell) {
        totalInvested = totalInvested.plus(pos.investedAmount.toString());
      }
      const profit = saleValue.minus(totalInvested);
      const profitPercent = profit.dividedBy(totalInvested).times(100);

      logger.info(
        {
          orderId: order.id,
          price: executedPrice.toString(),
          quantity: executedQuantity.toString(),
          saleValue: saleValue.toString(),
          profit: profit.toString(),
          profitPercent: profitPercent.toFixed(2) + '%',
        },
        'Sell executed successfully'
      );
    } catch (error) {
      logger.error({ error, batchId: batch.id }, 'Sell execution failed');
      throw error;
    }
  }

  /**
   * Log de status do tick
   */
  private async logStatus(batch: PositionBatch, currentPrice: Decimal): Promise<void> {
    const summary = await positionManager.getBatchSummary(batch.id, currentPrice);

    if (!summary) return;

    logger.debug(
      {
        symbol: this.symbol,
        currentPrice: currentPrice.toString(),
        positions: summary.positionCount,
        avgPrice: summary.averagePrice.toString(),
        nextBuy: summary.nextBuyPrice.toString(),
        targetSell: summary.targetSellPrice.toString(),
        pnl: summary.currentPnL?.toFixed(2),
        pnlPercent: summary.currentPnLPercent?.toFixed(2) + '%',
      },
      'Tick status'
    );
  }
}

// Export singleton
export const dcaStrategy = new DCAStrategy();
