import { prisma } from '../lib/prisma.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import type { Cycle, PerformanceSummary } from '../types/index.js';

const logger = createChildLogger({ service: 'MetricsService' });

export class MetricsService {
  async recordCycleCompletion(cycle: Cycle): Promise<void> {
    const profitPercent = cycle.profitPercent
      ? new Decimal(cycle.profitPercent.toString())
      : new Decimal(0);

    const isWin = profitPercent.greaterThan(0);

    logger.info(
      {
        cycleId: cycle.id,
        symbol: cycle.symbol,
        profitPercent: profitPercent.toFixed(2) + '%',
        isWin,
      },
      'Recording cycle completion'
    );
  }

  async snapshotMetrics(symbol?: string): Promise<void> {
    try {
      const summary = await this.getPerformanceSummary(symbol);

      await prisma.metrics.create({
        data: {
          symbol: symbol ?? null,
          totalCycles: summary.totalCycles,
          winningCycles: Math.round(summary.totalCycles * summary.winRate.toNumber()),
          losingCycles: Math.round(summary.totalCycles * (1 - summary.winRate.toNumber())),
          winRate: summary.winRate.toNumber(),
          totalProfit: summary.netProfit.toNumber(),
          netProfit: summary.netProfit.toNumber(),
          maxDrawdown: summary.maxDrawdown.toNumber(),
          maxExposureHit: summary.maxExposureHit.toNumber(),
          avgCycleDuration: summary.avgCycleDurationMinutes,
        },
      });

      logger.info(
        {
          symbol: symbol ?? 'GLOBAL',
          totalCycles: summary.totalCycles,
          winRate: summary.winRate.toFixed(2),
          netProfit: summary.netProfit.toFixed(2),
          maxDrawdown: summary.maxDrawdown.toFixed(4),
        },
        'Metrics snapshot saved'
      );
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to snapshot metrics');
    }
  }

  async getPerformanceSummary(symbol?: string): Promise<PerformanceSummary> {
    const where = symbol
      ? { status: 'COMPLETED' as const, symbol }
      : { status: 'COMPLETED' as const };

    const completedCycles = await prisma.cycle.findMany({
      where,
      select: {
        totalProfit: true,
        profitPercent: true,
        totalInvested: true,
        createdAt: true,
        closedAt: true,
      },
    });

    const totalCycles = completedCycles.length;

    if (totalCycles === 0) {
      return {
        totalCycles: 0,
        winRate: new Decimal(0),
        netProfit: new Decimal(0),
        maxDrawdown: new Decimal(0),
        avgCycleDurationMinutes: 0,
        maxExposureHit: new Decimal(0),
      };
    }

    let winCount = 0;
    let netProfit = new Decimal(0);
    let totalDurationMs = 0;
    let maxExposure = new Decimal(0);

    for (const cycle of completedCycles) {
      const profit = new Decimal(cycle.totalProfit?.toString() ?? '0');
      if (profit.greaterThan(0)) winCount++;
      netProfit = netProfit.plus(profit);

      const invested = new Decimal(cycle.totalInvested.toString());
      if (invested.greaterThan(maxExposure)) {
        maxExposure = invested;
      }

      if (cycle.closedAt && cycle.createdAt) {
        totalDurationMs += cycle.closedAt.getTime() - cycle.createdAt.getTime();
      }
    }

    const winRate = new Decimal(winCount).dividedBy(new Decimal(totalCycles));
    const avgDurationMinutes = Math.round(totalDurationMs / totalCycles / 60000);

    // Get max drawdown from bot state
    const botState = await prisma.botState.findFirst({
      where: { symbol: symbol ?? null },
    });
    const maxDrawdown = botState
      ? new Decimal(botState.maxDrawdownHit.toString())
      : new Decimal(0);

    return {
      totalCycles,
      winRate,
      netProfit,
      maxDrawdown,
      avgCycleDurationMinutes: avgDurationMinutes,
      maxExposureHit: maxExposure,
    };
  }
}

export const metricsService = new MetricsService();
