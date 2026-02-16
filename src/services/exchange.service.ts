import ccxt, { type Exchange, type Ticker, type Order, type Balances } from 'ccxt';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal, EXCHANGE } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import { withRetry } from '../utils/helpers.js';
import type { OrderResult } from '../types/index.js';

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

    await withRetry(
      async () => {
        logger.info({ sandbox: config.EXCHANGE_SANDBOX }, 'Initializing exchange connection');
        await this.exchange.loadMarkets();
        await this.exchange.fetchBalance();
        this.initialized = true;
        logger.info('Exchange initialized successfully');
      },
      EXCHANGE.MAX_RETRIES,
      EXCHANGE.RETRY_DELAY_MS,
      logger,
      'exchange.initialize'
    );
  }

  async getCurrentPrice(symbol: string): Promise<DecimalType> {
    return withRetry(
      async () => {
        const ticker: Ticker = await this.exchange.fetchTicker(symbol);
        if (!ticker.last) {
          throw new Error(`No price available for ${symbol}`);
        }
        const price = new Decimal(ticker.last);
        logger.debug({ symbol, price: price.toString() }, 'Fetched current price');
        return price;
      },
      EXCHANGE.MAX_RETRIES,
      EXCHANGE.RETRY_DELAY_MS,
      logger,
      `getCurrentPrice(${symbol})`
    );
  }

  async getBalance(currency: string = 'USDT'): Promise<DecimalType> {
    return withRetry(
      async () => {
        const balances: Balances = await this.exchange.fetchBalance();
        const free = balances[currency]?.free ?? 0;
        const balance = new Decimal(free);
        logger.debug({ currency, balance: balance.toString() }, 'Fetched balance');
        return balance;
      },
      EXCHANGE.MAX_RETRIES,
      EXCHANGE.RETRY_DELAY_MS,
      logger,
      `getBalance(${currency})`
    );
  }

  async getTotalBalanceInUSDT(symbols: string[]): Promise<DecimalType> {
    const balances: Balances = await this.exchange.fetchBalance();
    let total = new Decimal(balances['USDT']?.free ?? 0);

    for (const symbol of symbols) {
      const base = symbol.split('/')[0];
      const free = balances[base]?.free ?? 0;
      if (Number(free) > 0) {
        try {
          const ticker = await this.exchange.fetchTicker(symbol);
          if (ticker.last) {
            total = total.plus(new Decimal(free).times(new Decimal(ticker.last)));
          }
        } catch {
          logger.warn({ base }, 'Could not value asset in USDT');
        }
      }
    }

    return total;
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

    return withRetry(
      async () => {
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
      },
      1, // No retry on buy orders - risk of double buying
      0,
      logger,
      `buyOrder(${symbol})`
    );
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

    return withRetry(
      async () => {
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
      },
      1, // No retry on sell orders
      0,
      logger,
      `sellOrder(${symbol})`
    );
  }

  async fetchRecentPrices(
    symbol: string,
    timeframeMinutes: number
  ): Promise<Array<{ price: number; timestamp: number }>> {
    try {
      const candleCount = Math.ceil(timeframeMinutes / 15);
      const ohlcv = await this.exchange.fetchOHLCV(symbol, '15m', undefined, candleCount);

      return ohlcv.map((candle) => ({
        price: candle[4] as number, // close price
        timestamp: candle[0] as number,
      }));
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch recent prices');
      return [];
    }
  }

  async getMinOrderSize(symbol: string): Promise<DecimalType> {
    try {
      const market = this.exchange.market(symbol);
      const minCost = market.limits?.cost?.min ?? 10;
      return new Decimal(minCost);
    } catch {
      logger.warn({ symbol }, 'Could not get min order size, using default');
      return EXCHANGE.MIN_ORDER_VALUE_USDT;
    }
  }

  private mapOrderResult(order: Order): OrderResult {
    const expectedPrice = order.price ?? 0;
    const executedPrice = order.average ?? order.price ?? 0;
    const slippage = expectedPrice > 0
      ? Math.abs(executedPrice - expectedPrice) / expectedPrice
      : 0;

    return {
      id: order.id,
      symbol: order.symbol,
      side: order.side as 'buy' | 'sell',
      type: order.type ?? 'market',
      status: order.status ?? 'closed',
      price: executedPrice,
      amount: order.amount ?? 0,
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      cost: order.cost ?? 0,
      fee: order.fee
        ? { cost: order.fee.cost ?? 0, currency: order.fee.currency ?? '' }
        : undefined,
      timestamp: order.timestamp ?? Date.now(),
      slippage,
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export const exchangeService = new ExchangeService();
