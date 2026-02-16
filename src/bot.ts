import dns from 'node:dns';

// Forcar IPv4 para evitar bloqueio da Binance com IPv6
dns.setDefaultResultOrder('ipv4first');

import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import { exchangeService } from './services/exchange.service.js';
import { metricsService } from './services/metrics.service.js';
import { notificationService } from './services/notification.service.js';
import { GridStrategy } from './strategies/grid.strategy.js';

class TradingBot {
  private strategies = new Map<string, GridStrategy>();
  private tickInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    logger.info('========================================');
    logger.info('    ROBO-INVEST ADAPTIVE GRID BOT      ');
    logger.info('========================================');
    logger.info(
      {
        symbols: config.TRADING_SYMBOLS,
        gridDrop: `${config.GRID_DROP_PERCENT * 100}%`,
        gridDropHighVol: `${config.GRID_DROP_PERCENT_HIGH_VOL * 100}%`,
        maxBuys: config.GRID_MAX_BUYS,
        profitTarget: `${config.GRID_PROFIT_TARGET * 100}%`,
        trailingStop: `${config.GRID_TRAILING_STOP_PERCENT * 100}%`,
        partialSell: `${config.GRID_PARTIAL_SELL_PERCENT * 100}%`,
        maxExposure: `${config.CAPITAL_MAX_EXPOSURE * 100}%`,
        entryPercent: `${config.CAPITAL_ENTRY_PERCENT * 100}%`,
        rsiThreshold: config.ENTRY_RSI_THRESHOLD,
        maxDrawdown: `${config.RISK_MAX_DRAWDOWN * 100}%`,
        tickInterval: `${config.TICK_INTERVAL_MS}ms`,
        sandbox: config.EXCHANGE_SANDBOX,
        telegram: config.TELEGRAM_ENABLED,
      },
      'Configuration loaded'
    );

    try {
      // 1. Connect database
      logger.info('Connecting to database...');
      await prisma.$connect();
      logger.info('Database connected');

      // 2. Initialize exchange
      logger.info('Initializing exchange...');
      await exchangeService.initialize();
      logger.info('Exchange initialized');

      // 3. Create strategy instances (one per symbol)
      for (const symbol of config.TRADING_SYMBOLS) {
        this.strategies.set(symbol, new GridStrategy(symbol));
        logger.info({ symbol }, 'Strategy instance created');
      }

      // 4. Setup shutdown handlers
      this.setupShutdownHandlers();

      // 5. Start tick loop
      this.startTickLoop();

      // 6. Start metrics loop
      this.startMetricsLoop();

      logger.info('Bot started successfully');
      logger.info('----------------------------------------');

      await notificationService.notify({
        type: 'BOT_RESUMED',
        message: `*BOT STARTED*\nSymbols: ${config.TRADING_SYMBOLS.join(', ')}\nMode: ${config.EXCHANGE_SANDBOX ? 'SANDBOX' : 'LIVE'}`,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start bot');
      await this.shutdown(1);
    }
  }

  private startTickLoop(): void {
    logger.info(
      { intervalMs: config.TICK_INTERVAL_MS, symbols: config.TRADING_SYMBOLS.length },
      'Starting tick loop'
    );

    // First tick immediately
    this.executeTick().catch((err) => logger.error({ err }, 'First tick failed'));

    // Subsequent ticks
    this.tickInterval = setInterval(() => {
      this.executeTick().catch((err) => logger.error({ err }, 'Tick failed'));
    }, config.TICK_INTERVAL_MS);
  }

  private startMetricsLoop(): void {
    const intervalMs = config.METRICS_INTERVAL_MINUTES * 60 * 1000;

    this.metricsInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      await this.executeMetricsSnapshot();
    }, intervalMs);

    logger.info(
      { intervalMinutes: config.METRICS_INTERVAL_MINUTES },
      'Metrics snapshot loop started'
    );
  }

  private async executeTick(): Promise<void> {
    if (this.isShuttingDown) return;

    // Process each symbol sequentially to avoid race conditions on balance
    for (const [symbol, strategy] of this.strategies) {
      try {
        await strategy.tick();
      } catch (error) {
        logger.error({ error, symbol }, 'Tick execution failed for symbol');
      }
    }
  }

  private async executeMetricsSnapshot(): Promise<void> {
    try {
      // Global metrics
      await metricsService.snapshotMetrics();

      // Per-symbol metrics
      for (const symbol of config.TRADING_SYMBOLS) {
        await metricsService.snapshotMetrics(symbol);
      }
    } catch (error) {
      logger.error({ error }, 'Metrics snapshot failed');
    }
  }

  private setupShutdownHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info({ signal }, 'Shutdown signal received');
        await this.shutdown(0);
      });
    }

    process.on('uncaughtException', async (error) => {
      logger.error({ error }, 'Uncaught exception');
      await this.shutdown(1);
    });

    process.on('unhandledRejection', async (reason) => {
      logger.error({ reason }, 'Unhandled rejection');
      await this.shutdown(1);
    });
  }

  private async shutdown(code: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down bot...');

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    // Final metrics snapshot
    try {
      await this.executeMetricsSnapshot();
    } catch {
      // Ignore errors during shutdown
    }

    try {
      await prisma.$disconnect();
      logger.info('Database disconnected');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting database');
    }

    logger.info('Bot shutdown complete');
    process.exit(code);
  }
}

// Entry point
const bot = new TradingBot();
bot.start();
