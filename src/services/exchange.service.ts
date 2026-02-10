import ccxt, { type Exchange, type Ticker, type Order, type Balances } from 'ccxt';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal, EXCHANGE } from '../utils/constants.js';
import type { OrderResult } from '../types/index.js';

type DecimalType = InstanceType<typeof Decimal>;

const logger = createChildLogger({ service: 'ExchangeService' });

export class ExchangeService {
  private exchange: Exchange;
  private initialized = false;

  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: config.EXCHANGE_API_KEY,
      secret: config.EXCHANGE_API_SECRET,
      sandbox: config.EXCHANGE_SANDBOX,
      timeout: EXCHANGE.DEFAULT_TIMEOUT_MS,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      logger.info({ sandbox: config.EXCHANGE_SANDBOX }, 'Initializing exchange connection');

      await this.exchange.loadMarkets();

      // Verificar conexão obtendo balance
      await this.exchange.fetchBalance();

      this.initialized = true;
      logger.info('Exchange initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize exchange');
      throw error;
    }
  }

  async getCurrentPrice(symbol: string): Promise<DecimalType> {
    try {
      const ticker: Ticker = await this.exchange.fetchTicker(symbol);

      if (!ticker.last) {
        throw new Error(`No price available for ${symbol}`);
      }

      const price = new Decimal(ticker.last);
      logger.debug({ symbol, price: price.toString() }, 'Fetched current price');

      return price;
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch price');
      throw error;
    }
  }

  async getBalance(currency: string = 'USDT'): Promise<DecimalType> {
    try {
      const balances: Balances = await this.exchange.fetchBalance();
      const free = balances[currency]?.free ?? 0;
      const balance = new Decimal(free);

      logger.debug({ currency, balance: balance.toString() }, 'Fetched balance');

      return balance;
    } catch (error) {
      logger.error({ error, currency }, 'Failed to fetch balance');
      throw error;
    }
  }

  async createMarketBuyOrder(
    symbol: string,
    amountInQuote: number
  ): Promise<OrderResult> {
    const operationId = crypto.randomUUID();

    logger.info(
      { operationId, symbol, amountInQuote },
      'Creating market buy order'
    );

    try {
      // Binance: para market buy, usamos createMarketBuyOrder com quote amount
      const order: Order = await this.exchange.createMarketBuyOrder(
        symbol,
        amountInQuote,
        { quoteOrderQty: amountInQuote }
      );

      const result = this.mapOrderResult(order);

      logger.info(
        {
          operationId,
          orderId: result.id,
          filled: result.filled,
          price: result.price,
          cost: result.cost,
        },
        'Market buy order executed'
      );

      return result;
    } catch (error) {
      logger.error({ operationId, symbol, amountInQuote, error }, 'Buy order failed');

      if (error instanceof ccxt.InsufficientFunds) {
        throw new Error(`Insufficient funds to buy ${symbol}`);
      }
      if (error instanceof ccxt.InvalidOrder) {
        throw new Error(`Invalid order for ${symbol}: ${(error as Error).message}`);
      }

      throw error;
    }
  }

  async createMarketSellOrder(
    symbol: string,
    quantity: number
  ): Promise<OrderResult> {
    const operationId = crypto.randomUUID();

    logger.info(
      { operationId, symbol, quantity },
      'Creating market sell order'
    );

    try {
      const order: Order = await this.exchange.createMarketSellOrder(
        symbol,
        quantity
      );

      const result = this.mapOrderResult(order);

      logger.info(
        {
          operationId,
          orderId: result.id,
          filled: result.filled,
          price: result.price,
          cost: result.cost,
        },
        'Market sell order executed'
      );

      return result;
    } catch (error) {
      logger.error({ operationId, symbol, quantity, error }, 'Sell order failed');

      if (error instanceof ccxt.InsufficientFunds) {
        throw new Error(`Insufficient ${symbol.split('/')[0]} to sell`);
      }

      throw error;
    }
  }

  async getMinOrderSize(symbol: string): Promise<DecimalType> {
    try {
      const market = this.exchange.market(symbol);
      const minCost = market.limits?.cost?.min ?? 10;
      return new Decimal(minCost);
    } catch (error) {
      logger.warn({ symbol }, 'Could not get min order size, using default');
      return new Decimal(10);
    }
  }

  private mapOrderResult(order: Order): OrderResult {
    return {
      id: order.id,
      symbol: order.symbol,
      side: order.side as 'buy' | 'sell',
      type: order.type ?? 'market',
      status: order.status ?? 'closed',
      price: order.average ?? order.price ?? 0,
      amount: order.amount ?? 0,
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      cost: order.cost ?? 0,
      fee: order.fee
        ? { cost: order.fee.cost ?? 0, currency: order.fee.currency ?? '' }
        : undefined,
      timestamp: order.timestamp ?? Date.now(),
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// Export singleton
export const exchangeService = new ExchangeService();
