import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal, EXCHANGE } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import { exchangeService } from '../services/exchange.service.js';
import { capitalManager } from '../services/capital-manager.service.js';
import { positionManager } from '../services/position-manager.service.js';
import { indicatorService } from '../services/indicator.service.js';
import { riskManager } from '../services/risk-manager.service.js';
import { metricsService } from '../services/metrics.service.js';
import { notificationService } from '../services/notification.service.js';
import type { Cycle, StrategyAction } from '../types/index.js';

export class GridStrategy {
  private symbol: string;
  private isRunning = false;
  private logger;

  constructor(symbol: string) {
    this.symbol = symbol;
    this.logger = createChildLogger({ service: 'GridStrategy', symbol });
  }

  async tick(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous tick still running, skipping');
      return;
    }

    this.isRunning = true;

    try {
      // 1. Risk check
      const tradeCheck = await riskManager.canTrade(this.symbol);
      if (!tradeCheck.allowed) {
        // If crash-paused, check recovery via RSI
        const symbolState = await riskManager.getBotState(this.symbol);
        if (symbolState.state === 'PAUSED_CRASH') {
          const snapshot = await indicatorService.getIndicatorSnapshot(this.symbol);
          const rsi = snapshot.rsi15m ?? snapshot.rsi1h;
          await riskManager.resolveCrashIfRecovered(this.symbol, rsi);
        }
        this.logger.debug({ reason: tradeCheck.reason }, 'Trading not allowed');
        return;
      }

      // 2. Get current price
      const currentPrice = await exchangeService.getCurrentPrice(this.symbol);

      // 3. Get indicators
      const indicators = await indicatorService.getIndicatorSnapshot(this.symbol);

      // 4. Update global balance & check drawdown
      const totalBalance = await capitalManager.getTotalBalance();
      await riskManager.updateBalance(totalBalance);

      const drawdownCheck = await riskManager.checkDrawdown();
      if (drawdownCheck.paused) return;

      // 5. Check crash condition
      const isCrash = await riskManager.checkCrashCondition(this.symbol, currentPrice);
      if (isCrash) return;

      // 6. Get active cycle
      const cycle = await positionManager.getActiveCycle(this.symbol);

      // 7. Evaluate based on cycle state
      let action: StrategyAction;

      if (!cycle) {
        action = this.evaluateSearching(currentPrice, indicators, totalBalance);
      } else {
        switch (cycle.status) {
          case 'ACTIVE':
            action = await this.evaluateActive(cycle, currentPrice, totalBalance);
            break;
          case 'PARTIAL_SELL':
            action = this.evaluatePartialSell(cycle, currentPrice);
            break;
          case 'TRAILING':
            action = await this.evaluateTrailing(cycle, currentPrice);
            break;
          case 'PAUSED':
            action = { type: 'WAIT', reason: 'Cycle paused' };
            break;
          default:
            action = { type: 'WAIT', reason: `Unknown cycle status: ${cycle.status}` };
        }
      }

      // 8. Execute action
      await this.executeAction(cycle, currentPrice, totalBalance, indicators, action);

      // 9. Log status
      if (cycle && action.type === 'WAIT') {
        await this.logStatus(cycle, currentPrice);
      }
    } catch (error) {
      this.logger.error({ error }, 'Error in strategy tick');
    } finally {
      this.isRunning = false;
    }
  }

  // ============================================
  // STATE EVALUATORS
  // ============================================

  private evaluateSearching(
    currentPrice: DecimalType,
    indicators: ReturnType<typeof indicatorService.getIndicatorSnapshot> extends Promise<infer T> ? T : never,
    totalBalance: DecimalType
  ): StrategyAction {
    // Check EMA200 filter
    if (!indicatorService.isAboveEma200(currentPrice, indicators.ema200_4h)) {
      return { type: 'WAIT', reason: 'Price below EMA200 (4H)' };
    }

    // Check RSI
    const rsiThreshold = config.ENTRY_RSI_THRESHOLD;
    const rsi15mOk = indicators.rsi15m !== null && indicators.rsi15m < rsiThreshold;
    const rsi1hOk = indicators.rsi1h !== null && indicators.rsi1h < rsiThreshold;

    if (!rsi15mOk && !rsi1hOk) {
      return {
        type: 'WAIT',
        reason: `RSI not oversold (15m: ${indicators.rsi15m?.toFixed(1) ?? 'N/A'}, 1h: ${indicators.rsi1h?.toFixed(1) ?? 'N/A'})`,
      };
    }

    // Check volume (optional)
    if (config.ENTRY_VOLUME_LOOKBACK > 0 && indicators.volumeRatio !== null) {
      if (indicators.volumeRatio <= 1.0) {
        return { type: 'WAIT', reason: `Volume below average (ratio: ${indicators.volumeRatio.toFixed(2)})` };
      }
    }

    // Check if we have enough capital
    const entrySize = capitalManager.calculateEntrySize(totalBalance);
    if (entrySize.lessThan(EXCHANGE.MIN_ORDER_VALUE_USDT)) {
      return { type: 'WAIT', reason: 'Entry size too small' };
    }

    return { type: 'OPEN_CYCLE', reason: 'All entry criteria met' };
  }

  private async evaluateActive(
    cycle: Cycle,
    currentPrice: DecimalType,
    totalBalance: DecimalType
  ): Promise<StrategyAction> {
    const targetSellPrice = new Decimal(cycle.targetSellPrice.toString());
    const nextBuyPrice = new Decimal(cycle.nextBuyPrice.toString());

    // Check sell condition first
    if (currentPrice.greaterThanOrEqualTo(targetSellPrice)) {
      return {
        type: 'PARTIAL_SELL',
        reason: `Price ${currentPrice.toFixed(2)} >= target ${targetSellPrice.toFixed(2)}`,
        sellPercent: config.GRID_PARTIAL_SELL_PERCENT,
      };
    }

    // Check DCA buy condition
    if (currentPrice.lessThanOrEqualTo(nextBuyPrice)) {
      // Check max buys
      if (cycle.buyCount >= cycle.maxBuys) {
        return {
          type: 'WAIT',
          reason: `Max buys reached (${cycle.buyCount}/${cycle.maxBuys})`,
        };
      }

      // Check EMA200 - don't DCA below EMA200
      const indicators = await indicatorService.getIndicatorSnapshot(this.symbol);
      if (!indicatorService.isAboveEma200(currentPrice, indicators.ema200_4h)) {
        return { type: 'WAIT', reason: 'Price below EMA200, DCA suspended' };
      }

      // Check exposure limit
      const currentInvested = new Decimal(cycle.totalInvested.toString());
      const buyCheck = await capitalManager.canExecuteBuy(totalBalance, currentInvested, this.symbol);

      if (!buyCheck.canBuy) {
        return { type: 'WAIT', reason: buyCheck.reason ?? 'Cannot execute buy' };
      }

      return {
        type: 'DCA_BUY',
        reason: `Price ${currentPrice.toFixed(2)} <= nextBuy ${nextBuyPrice.toFixed(2)}`,
        buyNumber: cycle.buyCount + 1,
      };
    }

    return { type: 'WAIT', reason: 'Waiting for price action' };
  }

  private evaluatePartialSell(_cycle: Cycle, currentPrice: DecimalType): StrategyAction {
    // After partial sell, activate trailing stop
    return {
      type: 'UPDATE_TRAILING',
      newStopPrice: currentPrice.times(new Decimal(1).minus(new Decimal(config.GRID_TRAILING_STOP_PERCENT))),
    };
  }

  private async evaluateTrailing(cycle: Cycle, currentPrice: DecimalType): Promise<StrategyAction> {
    const trailingResult = await positionManager.updateTrailingStop(cycle.id, currentPrice);

    if (trailingResult.triggered) {
      return {
        type: 'TRAILING_SELL',
        reason: `Trailing stop triggered at ${trailingResult.stopPrice.toFixed(2)}`,
      };
    }

    return { type: 'WAIT', reason: `Trailing active (stop: ${trailingResult.stopPrice.toFixed(2)})` };
  }

  // ============================================
  // ACTION EXECUTORS
  // ============================================

  private async executeAction(
    cycle: Cycle | null,
    currentPrice: DecimalType,
    totalBalance: DecimalType,
    indicators: ReturnType<typeof indicatorService.getIndicatorSnapshot> extends Promise<infer T> ? T : never,
    action: StrategyAction
  ): Promise<void> {
    switch (action.type) {
      case 'WAIT':
        this.logger.info({ reason: action.reason }, 'WAIT');
        break;

      case 'OPEN_CYCLE':
        await this.executeOpenCycle(currentPrice, totalBalance, indicators);
        break;

      case 'DCA_BUY':
        if (cycle) await this.executeDCABuy(cycle, currentPrice, totalBalance, action.buyNumber);
        break;

      case 'PARTIAL_SELL':
        if (cycle) await this.executePartialSell(cycle, currentPrice, action.sellPercent);
        break;

      case 'UPDATE_TRAILING':
        if (cycle) {
          const trailingPercent = new Decimal(config.GRID_TRAILING_STOP_PERCENT);
          await positionManager.activateTrailingStop(cycle.id, currentPrice, trailingPercent);
          this.logger.info({ cycleId: cycle.id }, 'Trailing stop activated after partial sell');
        }
        break;

      case 'TRAILING_SELL':
        if (cycle) await this.executeTrailingSell(cycle, currentPrice);
        break;

      case 'FULL_CLOSE':
        if (cycle) await this.executeFullClose(cycle, currentPrice);
        break;
    }
  }

  private async executeOpenCycle(
    currentPrice: DecimalType,
    totalBalance: DecimalType,
    indicators: ReturnType<typeof indicatorService.getIndicatorSnapshot> extends Promise<infer T> ? T : never
  ): Promise<void> {
    const gridPercent = indicatorService.adaptGridPercent(indicators.atr14_4h, currentPrice);

    // Create cycle
    const cycle = await positionManager.createCycle(
      this.symbol,
      totalBalance,
      indicators,
      gridPercent
    );

    // Execute initial buy
    const entrySize = capitalManager.calculateEntrySize(totalBalance);

    this.logger.info(
      {
        cycleId: cycle.id,
        entrySize: entrySize.toString(),
        price: currentPrice.toString(),
        gridPercent,
      },
      'Opening new cycle with initial buy'
    );

    try {
      const order = await exchangeService.createMarketBuyOrder(
        this.symbol,
        entrySize.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const investedAmount = new Decimal(order.cost);

      await positionManager.addPosition(
        cycle.id,
        {
          symbol: this.symbol,
          quantity: executedQuantity,
          entryPrice: executedPrice,
          investedAmount,
          buyNumber: 1,
        },
        order.id,
        order.fee
      );

      await positionManager.logTrade(
        this.symbol, 'buy', executedQuantity, executedPrice, investedAmount,
        { cycleId: cycle.id, reason: 'INITIAL_BUY', orderId: order.id }
      );

      const rsi = indicators.rsi15m ?? indicators.rsi1h ?? 0;
      await notificationService.notifyBuy(this.symbol, executedPrice, investedAmount, 1);
      await notificationService.notifyCycleStart(this.symbol, executedPrice, rsi);

      this.logger.info(
        { orderId: order.id, price: executedPrice.toString(), cost: investedAmount.toString() },
        'Initial buy executed'
      );
    } catch (error) {
      this.logger.error({ error, cycleId: cycle.id }, 'Initial buy failed');
      await positionManager.updateCycleStatus(cycle.id, 'COMPLETED');
    }
  }

  private async executeDCABuy(
    cycle: Cycle,
    currentPrice: DecimalType,
    totalBalance: DecimalType,
    buyNumber: number
  ): Promise<void> {
    const entrySize = capitalManager.calculateEntrySize(totalBalance);

    this.logger.info(
      {
        cycleId: cycle.id,
        buyNumber,
        entrySize: entrySize.toString(),
        price: currentPrice.toString(),
      },
      'Executing DCA buy'
    );

    try {
      const order = await exchangeService.createMarketBuyOrder(
        this.symbol,
        entrySize.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const investedAmount = new Decimal(order.cost);

      await positionManager.addPosition(
        cycle.id,
        {
          symbol: this.symbol,
          quantity: executedQuantity,
          entryPrice: executedPrice,
          investedAmount,
          buyNumber,
        },
        order.id,
        order.fee
      );

      await positionManager.logTrade(
        this.symbol, 'buy', executedQuantity, executedPrice, investedAmount,
        { cycleId: cycle.id, reason: `DCA_BUY_${buyNumber}`, orderId: order.id }
      );

      await notificationService.notifyBuy(this.symbol, executedPrice, investedAmount, buyNumber);

      this.logger.info(
        { orderId: order.id, buyNumber, price: executedPrice.toString(), cost: investedAmount.toString() },
        'DCA buy executed'
      );
    } catch (error) {
      this.logger.error({ error, cycleId: cycle.id, buyNumber }, 'DCA buy failed');
    }
  }

  private async executePartialSell(
    cycle: Cycle,
    currentPrice: DecimalType,
    sellPercent: number
  ): Promise<void> {
    const remainingQuantity = new Decimal(cycle.remainingQuantity.toString());
    const sellQuantity = remainingQuantity.times(new Decimal(sellPercent));

    this.logger.info(
      {
        cycleId: cycle.id,
        sellPercent,
        sellQuantity: sellQuantity.toString(),
        price: currentPrice.toString(),
      },
      'Executing partial sell'
    );

    try {
      const order = await exchangeService.createMarketSellOrder(
        this.symbol,
        sellQuantity.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const saleValue = new Decimal(order.cost);
      const sellPercentDecimal = new Decimal(sellPercent);

      await positionManager.partialClosePositions(
        cycle.id,
        sellPercentDecimal,
        executedPrice,
        order.id
      );

      await positionManager.logTrade(
        this.symbol, 'sell', executedQuantity, executedPrice, saleValue,
        { cycleId: cycle.id, reason: 'PARTIAL_SELL', orderId: order.id }
      );

      await notificationService.notifyPartialSell(this.symbol, executedPrice, executedQuantity, sellPercent);

      this.logger.info(
        { orderId: order.id, sold: executedQuantity.toString(), value: saleValue.toString() },
        'Partial sell executed'
      );
    } catch (error) {
      this.logger.error({ error, cycleId: cycle.id }, 'Partial sell failed');
    }
  }

  private async executeTrailingSell(cycle: Cycle, currentPrice: DecimalType): Promise<void> {
    const remainingQuantity = new Decimal(cycle.remainingQuantity.toString());

    this.logger.info(
      {
        cycleId: cycle.id,
        quantity: remainingQuantity.toString(),
        price: currentPrice.toString(),
      },
      'Executing trailing stop sell'
    );

    try {
      const order = await exchangeService.createMarketSellOrder(
        this.symbol,
        remainingQuantity.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      const executedQuantity = new Decimal(order.filled);
      const saleValue = new Decimal(order.cost);

      await positionManager.fullClosePositions(cycle.id, executedPrice, order.id);

      await positionManager.logTrade(
        this.symbol, 'sell', executedQuantity, executedPrice, saleValue,
        { cycleId: cycle.id, reason: 'TRAILING_SELL', orderId: order.id }
      );

      // Record metrics - buscar ciclo atualizado com profit persistido
      const closedCycle = await positionManager.getCycleSummary(cycle.id);
      if (closedCycle) {
        await metricsService.recordCycleCompletion(cycle);
        const profitPercent = closedCycle.currentPnLPercent ?? new Decimal(0);
        const profit = closedCycle.currentPnL ?? new Decimal(0);

        await riskManager.recordCycleResult(this.symbol, profitPercent);
        await notificationService.notifyTrailingSell(this.symbol, executedPrice, executedQuantity);
        await notificationService.notifyCycleEnd(this.symbol, profit, profitPercent);
      }

      this.logger.info(
        { orderId: order.id, sold: executedQuantity.toString(), value: saleValue.toString() },
        'Trailing sell executed, cycle completed'
      );
    } catch (error) {
      this.logger.error({ error, cycleId: cycle.id }, 'Trailing sell failed');
    }
  }

  private async executeFullClose(cycle: Cycle, _currentPrice: DecimalType): Promise<void> {
    const remainingQuantity = new Decimal(cycle.remainingQuantity.toString());

    try {
      const order = await exchangeService.createMarketSellOrder(
        this.symbol,
        remainingQuantity.toNumber()
      );

      const executedPrice = new Decimal(order.price);
      await positionManager.fullClosePositions(cycle.id, executedPrice, order.id);

      this.logger.info({ cycleId: cycle.id }, 'Full close executed');
    } catch (error) {
      this.logger.error({ error, cycleId: cycle.id }, 'Full close failed');
    }
  }

  // ============================================
  // STATUS LOG
  // ============================================

  private async logStatus(cycle: Cycle, currentPrice: DecimalType): Promise<void> {
    const summary = await positionManager.getCycleSummary(cycle.id, currentPrice);
    if (!summary) return;

    this.logger.debug(
      {
        status: summary.status,
        price: currentPrice.toString(),
        buys: `${summary.buyCount}/${summary.maxBuys}`,
        avgPrice: summary.averagePrice.toString(),
        nextBuy: summary.nextBuyPrice.toString(),
        target: summary.targetSellPrice.toString(),
        pnl: summary.currentPnL?.toFixed(2),
        pnlPct: summary.currentPnLPercent?.toFixed(2) + '%',
        trailing: summary.trailingStopPrice?.toString() ?? 'N/A',
      },
      'Tick status'
    );
  }
}
