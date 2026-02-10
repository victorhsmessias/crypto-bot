import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { prisma } from './lib/prisma.js';
import { exchangeService } from './services/exchange.service.js';
import { dcaStrategy } from './strategies/dca.strategy.js';

class TradingBot {
  private tickInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    logger.info('========================================');
    logger.info('       ROBO-INVEST DCA BOT             ');
    logger.info('========================================');
    logger.info(
      {
        symbol: config.TRADING_SYMBOL,
        sellMode: config.TRADING_SELL_MODE,
        dropPercent: `${config.DCA_DROP_PERCENT * 100}%`,
        positionSize: `${config.DCA_POSITION_SIZE * 100}%`,
        profitTarget: `${config.DCA_PROFIT_TARGET * 100}%`,
        tickInterval: `${config.TICK_INTERVAL_MS}ms`,
        sandbox: config.EXCHANGE_SANDBOX,
      },
      'Configuration loaded'
    );

    try {
      // 1. Conectar ao banco de dados
      logger.info('Connecting to database...');
      await prisma.$connect();
      logger.info('Database connected');

      // 2. Inicializar exchange
      logger.info('Initializing exchange...');
      await exchangeService.initialize();
      logger.info('Exchange initialized');

      // 3. Configurar handlers de shutdown
      this.setupShutdownHandlers();

      // 4. Iniciar loop principal
      this.startTickLoop();

      logger.info('Bot started successfully');
      logger.info('----------------------------------------');
    } catch (error) {
      logger.error({ error }, 'Failed to start bot');
      await this.shutdown(1);
    }
  }

  private startTickLoop(): void {
    logger.info(
      { intervalMs: config.TICK_INTERVAL_MS },
      'Starting tick loop'
    );

    // Executar primeiro tick imediatamente
    this.executeTick();

    // Agendar ticks subsequentes
    this.tickInterval = setInterval(() => {
      this.executeTick();
    }, config.TICK_INTERVAL_MS);
  }

  private async executeTick(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      await dcaStrategy.tick();
    } catch (error) {
      logger.error({ error }, 'Tick execution failed');
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

    // Parar tick loop
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Desconectar do banco
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
