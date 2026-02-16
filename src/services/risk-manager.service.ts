import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import { exchangeService } from './exchange.service.js';
import { notificationService } from './notification.service.js';
import { percentChange } from '../utils/helpers.js';
import type { BotState, BotStateType } from '../types/index.js';

const logger = createChildLogger({ service: 'RiskManager' });

export class RiskManagerService {
  // ============================================
  // BOT STATE
  // ============================================

  async getBotState(symbol?: string): Promise<BotState> {
    const key = symbol ?? 'GLOBAL';

    let state = await prisma.botState.findFirst({
      where: { symbol: symbol ?? null },
    });

    if (!state) {
      state = await prisma.botState.create({
        data: {
          symbol: symbol ?? null,
          state: 'RUNNING',
          peakBalance: 0,
          currentBalance: 0,
          maxDrawdownHit: 0,
        },
      });
      logger.info({ key }, 'Created initial bot state');
    }

    return state;
  }

  async pauseBot(reason: BotStateType, symbol?: string): Promise<void> {
    const state = await this.getBotState(symbol);

    await prisma.botState.update({
      where: { id: state.id },
      data: { state: reason },
    });

    const label = symbol ?? 'GLOBAL';
    logger.warn({ reason, symbol: label }, 'Bot paused');
    await notificationService.notifyBotPaused(`${reason} (${label})`);
  }

  async resumeBot(symbol?: string): Promise<void> {
    const state = await this.getBotState(symbol);

    await prisma.botState.update({
      where: { id: state.id },
      data: {
        state: 'RUNNING',
        pausedUntil: null,
        crashDetectedAt: null,
        crashSuspendedUntil: null,
      },
    });

    logger.info({ symbol: symbol ?? 'GLOBAL' }, 'Bot resumed');
    await notificationService.notifyBotResumed();
  }

  // ============================================
  // COMBINED CHECK
  // ============================================

  async canTrade(symbol: string): Promise<{ allowed: boolean; reason?: string }> {
    // Check global state
    const globalState = await this.getBotState();
    if (globalState.state !== 'RUNNING') {
      return { allowed: false, reason: `Global bot paused: ${globalState.state}` };
    }

    // Check symbol state
    const symbolState = await this.getBotState(symbol);
    if (symbolState.state !== 'RUNNING') {
      // Check if lateral pause expired
      if (symbolState.state === 'PAUSED_LATERAL' && symbolState.pausedUntil) {
        if (new Date() > symbolState.pausedUntil) {
          await this.resumeBot(symbol);
          return { allowed: true };
        }
      }
      return { allowed: false, reason: `${symbol} paused: ${symbolState.state}` };
    }

    return { allowed: true };
  }

  // ============================================
  // DRAWDOWN TRACKING
  // ============================================

  async updateBalance(totalBalance: DecimalType): Promise<void> {
    const state = await this.getBotState();
    const peak = new Decimal(state.peakBalance.toString());

    const updates: Record<string, unknown> = {
      currentBalance: totalBalance.toNumber(),
    };

    if (totalBalance.greaterThan(peak) || peak.isZero()) {
      updates.peakBalance = totalBalance.toNumber();
    }

    await prisma.botState.update({
      where: { id: state.id },
      data: updates,
    });
  }

  async checkDrawdown(): Promise<{ paused: boolean; drawdownPercent: DecimalType }> {
    const state = await this.getBotState();
    const peak = new Decimal(state.peakBalance.toString());
    const current = new Decimal(state.currentBalance.toString());

    if (peak.isZero()) {
      return { paused: false, drawdownPercent: new Decimal(0) };
    }

    const drawdown = peak.minus(current).dividedBy(peak);

    // Update max drawdown
    const maxDrawdown = new Decimal(state.maxDrawdownHit.toString());
    if (drawdown.greaterThan(maxDrawdown)) {
      await prisma.botState.update({
        where: { id: state.id },
        data: { maxDrawdownHit: drawdown.toNumber() },
      });
    }

    const maxAllowed = new Decimal(config.RISK_MAX_DRAWDOWN);

    if (drawdown.greaterThanOrEqualTo(maxAllowed)) {
      logger.error(
        {
          drawdown: drawdown.toFixed(4),
          peak: peak.toString(),
          current: current.toString(),
        },
        'Max drawdown reached'
      );

      await this.pauseBot('PAUSED_DRAWDOWN');
      await notificationService.notifyDrawdownWarning(drawdown);

      return { paused: true, drawdownPercent: drawdown };
    }

    // Warning at 75% of max drawdown
    const warningThreshold = maxAllowed.times(new Decimal('0.75'));
    if (drawdown.greaterThanOrEqualTo(warningThreshold)) {
      logger.warn(
        { drawdown: drawdown.toFixed(4), threshold: maxAllowed.toFixed(4) },
        'Drawdown approaching limit'
      );
      await notificationService.notifyDrawdownWarning(drawdown);
    }

    return { paused: false, drawdownPercent: drawdown };
  }

  // ============================================
  // ANTI-CRASH DETECTION
  // ============================================

  async checkCrashCondition(symbol: string, currentPrice: DecimalType): Promise<boolean> {
    try {
      const timeWindowMinutes = config.RISK_CRASH_TIME_WINDOW_MINUTES;
      const recentPrices = await exchangeService.fetchRecentPrices(symbol, timeWindowMinutes);

      if (recentPrices.length < 2) return false;

      const oldestPrice = new Decimal(recentPrices[0].price);
      const dropPercent = percentChange(oldestPrice, currentPrice);

      const crashThreshold = new Decimal(config.RISK_CRASH_DROP_PERCENT).times(-1);

      if (dropPercent.lessThanOrEqualTo(crashThreshold)) {
        logger.error(
          {
            symbol,
            dropPercent: dropPercent.times(100).toFixed(2) + '%',
            oldestPrice: oldestPrice.toString(),
            currentPrice: currentPrice.toString(),
          },
          'Crash condition detected'
        );

        // Record crash event
        await prisma.crashEvent.create({
          data: {
            symbol,
            dropPercent: dropPercent.abs().toNumber(),
            timeWindowMinutes,
            priceAtDetection: currentPrice.toNumber(),
          },
        });

        // Pause symbol
        const state = await this.getBotState(symbol);
        await prisma.botState.update({
          where: { id: state.id },
          data: {
            state: 'PAUSED_CRASH',
            crashDetectedAt: new Date(),
          },
        });

        await notificationService.notifyCrashDetected(symbol, dropPercent.abs());

        return true;
      }
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to check crash condition');
    }

    return false;
  }

  async isCrashSuspended(symbol: string): Promise<boolean> {
    const state = await this.getBotState(symbol);
    return state.state === 'PAUSED_CRASH';
  }

  async resolveCrashIfRecovered(symbol: string, rsi: number | null): Promise<boolean> {
    if (rsi === null) return false;

    if (rsi > config.ENTRY_RSI_RECOVERY) {
      // Resolve unresolved crash events
      await prisma.crashEvent.updateMany({
        where: { symbol, resolved: false },
        data: { resolved: true, resolvedAt: new Date() },
      });

      await this.resumeBot(symbol);
      logger.info({ symbol, rsi }, 'Crash condition resolved (RSI recovered)');
      return true;
    }

    return false;
  }

  // ============================================
  // LATERAL MARKET DETECTION
  // ============================================

  async recordCycleResult(symbol: string, profitPercent: DecimalType): Promise<void> {
    const state = await this.getBotState(symbol);
    // profitPercent chega em formato percentual (ex: 3.0 para 3%)
    // threshold esta em formato decimal (ex: 0.005 para 0.5%)
    // Converter threshold para mesmo formato: 0.005 * 100 = 0.5
    const thresholdPercent = new Decimal(config.RISK_LATERAL_PROFIT_THRESHOLD).times(100);

    const isLowProfit = profitPercent.abs().lessThan(thresholdPercent);

    const newCount = isLowProfit ? state.consecutiveLowProfitCycles + 1 : 0;

    await prisma.botState.update({
      where: { id: state.id },
      data: { consecutiveLowProfitCycles: newCount },
    });

    if (newCount >= config.RISK_LATERAL_CYCLE_COUNT) {
      const pauseUntil = new Date();
      pauseUntil.setHours(pauseUntil.getHours() + config.RISK_LATERAL_PAUSE_HOURS);

      await prisma.botState.update({
        where: { id: state.id },
        data: {
          state: 'PAUSED_LATERAL',
          pausedUntil: pauseUntil,
          consecutiveLowProfitCycles: 0,
        },
      });

      logger.warn(
        {
          symbol,
          consecutiveCycles: newCount,
          pauseHours: config.RISK_LATERAL_PAUSE_HOURS,
        },
        'Lateral market detected, pausing'
      );

      await notificationService.notifyLateralDetected(symbol);
    }
  }

  async isLateralPaused(symbol: string): Promise<boolean> {
    const state = await this.getBotState(symbol);
    return state.state === 'PAUSED_LATERAL';
  }
}

export const riskManager = new RiskManagerService();
