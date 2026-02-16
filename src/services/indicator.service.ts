import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import { sleep } from '../utils/helpers.js';
import type { IndicatorSnapshot, EntryEvaluation } from '../types/index.js';

const logger = createChildLogger({ service: 'IndicatorService' });

interface CacheEntry {
  value: number;
  fetchedAt: number;
}

interface TaApiBulkIndicator {
  id?: string;
  indicator: string;
  exchange?: string;
  symbol?: string;
  interval?: string;
  period?: number;
}

interface TaApiBulkResponseItem {
  id?: string;
  indicator: string;
  result: { value: number } | Array<{ value: number }>;
}

export class IndicatorService {
  private cache = new Map<string, CacheEntry>();
  private requestTimestamps: number[] = [];
  private rateLimitPerWindow: number;
  private cacheTtlMs: number;

  constructor() {
    this.rateLimitPerWindow = config.TAAPI_RATE_LIMIT;
    this.cacheTtlMs = config.TAAPI_CACHE_TTL_SECONDS * 1000;
  }

  async getIndicatorSnapshot(symbol: string): Promise<IndicatorSnapshot> {
    const snapshot: IndicatorSnapshot = {
      rsi15m: null,
      rsi1h: null,
      ema200_4h: null,
      atr14_4h: null,
      volumeRatio: null,
      fetchedAt: new Date(),
    };

    // Check if everything is cached first
    const allCached = this.tryFillFromCache(symbol, snapshot);
    if (allCached) {
      logger.debug({ symbol, ...snapshot }, 'Indicator snapshot (all cached)');
      return snapshot;
    }

    try {
      // Build a single bulk request with all needed indicators across timeframes.
      // TaAPI bulk endpoint accepts per-indicator exchange/symbol/interval overrides,
      // so we consolidate EMA(4h), ATR(4h), RSI(15m), RSI(1h) into ONE API call.
      const indicators: TaApiBulkIndicator[] = [];

      if (this.getCached(`${symbol}:ema:4h`) === null || this.getCached(`${symbol}:atr:4h`) === null) {
        indicators.push(
          { id: 'ema_4h', indicator: 'ema', exchange: 'binance', symbol, interval: '4h', period: 200 },
          { id: 'atr_4h', indicator: 'atr', exchange: 'binance', symbol, interval: '4h', period: 14 },
        );
      }

      if (this.getCached(`${symbol}:rsi:15m`) === null) {
        indicators.push(
          { id: 'rsi_15m', indicator: 'rsi', exchange: 'binance', symbol, interval: '15m', period: 14 },
        );
      }

      if (this.getCached(`${symbol}:rsi:1h`) === null) {
        indicators.push(
          { id: 'rsi_1h', indicator: 'rsi', exchange: 'binance', symbol, interval: '1h', period: 14 },
        );
      }

      if (indicators.length > 0) {
        const results = await this.fetchBulkMulti(indicators);
        if (results) {
          if (results.ema_4h !== undefined) {
            this.setCache(`${symbol}:ema:4h`, results.ema_4h);
          }
          if (results.atr_4h !== undefined) {
            this.setCache(`${symbol}:atr:4h`, results.atr_4h);
          }
          if (results.rsi_15m !== undefined) {
            this.setCache(`${symbol}:rsi:15m`, results.rsi_15m);
          }
          if (results.rsi_1h !== undefined) {
            this.setCache(`${symbol}:rsi:1h`, results.rsi_1h);
          }
        }
      }

      // Fill snapshot from cache (including values just set above)
      this.tryFillFromCache(symbol, snapshot);
    } catch (error) {
      logger.error({ error, symbol }, 'Failed to fetch indicator snapshot');
    }

    logger.debug({ symbol, ...snapshot }, 'Indicator snapshot');
    return snapshot;
  }

  async evaluateEntry(symbol: string, currentPrice: DecimalType): Promise<EntryEvaluation> {
    const indicators = await this.getIndicatorSnapshot(symbol);
    const reasons: string[] = [];
    let canEnter = true;

    // Check EMA200 filter
    if (indicators.ema200_4h === null) {
      canEnter = false;
      reasons.push('EMA200 data unavailable');
    } else if (currentPrice.lessThanOrEqualTo(new Decimal(indicators.ema200_4h))) {
      canEnter = false;
      reasons.push(`Price ${currentPrice.toFixed(2)} below EMA200 ${indicators.ema200_4h.toFixed(2)}`);
    } else {
      reasons.push(`Price above EMA200 (${indicators.ema200_4h.toFixed(2)})`);
    }

    // Check RSI
    const rsiThreshold = config.ENTRY_RSI_THRESHOLD;
    const rsi15mOk = indicators.rsi15m !== null && indicators.rsi15m < rsiThreshold;
    const rsi1hOk = indicators.rsi1h !== null && indicators.rsi1h < rsiThreshold;

    if (!rsi15mOk && !rsi1hOk) {
      canEnter = false;
      reasons.push(`RSI not oversold (15m: ${indicators.rsi15m?.toFixed(1) ?? 'N/A'}, 1h: ${indicators.rsi1h?.toFixed(1) ?? 'N/A'}, threshold: ${rsiThreshold})`);
    } else {
      const which = rsi15mOk ? `15m=${indicators.rsi15m!.toFixed(1)}` : `1h=${indicators.rsi1h!.toFixed(1)}`;
      reasons.push(`RSI oversold (${which} < ${rsiThreshold})`);
    }

    // Check volume (optional)
    if (config.ENTRY_VOLUME_LOOKBACK > 0 && indicators.volumeRatio !== null) {
      if (indicators.volumeRatio <= 1.0) {
        reasons.push(`Volume below average (ratio: ${indicators.volumeRatio.toFixed(2)})`);
      } else {
        reasons.push(`Volume above average (ratio: ${indicators.volumeRatio.toFixed(2)})`);
      }
    }

    return { canEnter, reasons, indicators };
  }

  isAboveEma200(currentPrice: DecimalType, ema200: number | null): boolean {
    if (ema200 === null) return false;
    return currentPrice.greaterThan(new Decimal(ema200));
  }

  adaptGridPercent(atr: number | null, currentPrice: DecimalType): number {
    if (atr === null) return config.GRID_DROP_PERCENT;

    const atrRatio = new Decimal(atr).dividedBy(currentPrice);
    if (atrRatio.greaterThan('0.02')) {
      logger.debug(
        { atrRatio: atrRatio.toFixed(4) },
        'High volatility detected, using wider grid'
      );
      return config.GRID_DROP_PERCENT_HIGH_VOL;
    }

    return config.GRID_DROP_PERCENT;
  }

  // ============================================
  // BULK FETCH (single API call for all indicators)
  // ============================================

  private async fetchBulkMulti(
    indicators: TaApiBulkIndicator[]
  ): Promise<Record<string, number> | null> {
    await this.waitForRateLimit();

    try {
      // TaAPI bulk endpoint accepts an array of indicator objects,
      // each with its own exchange/symbol/interval override.
      // Symbol format: TaAPI expects "BTC/USDT" (with slash).
      const body = {
        secret: config.TAAPI_SECRET,
        construct: {
          exchange: 'binance',
          symbol: indicators[0].symbol,
          interval: indicators[0].interval,
          indicators: indicators.map((ind) => ({
            id: ind.id,
            indicator: ind.indicator,
            ...(ind.exchange && { exchange: ind.exchange }),
            ...(ind.symbol && { symbol: ind.symbol }),
            ...(ind.interval && { interval: ind.interval }),
            ...(ind.period && { period: ind.period }),
          })),
        },
      };

      logger.debug(
        { indicatorCount: indicators.length, ids: indicators.map((i) => i.id) },
        'Sending TaAPI bulk request'
      );

      const response = await fetch('https://api.taapi.io/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'TaAPI bulk request failed');
        return null;
      }

      const data = (await response.json()) as { data: TaApiBulkResponseItem[] };
      const result: Record<string, number> = {};

      for (const item of data.data) {
        const key = item.id ?? item.indicator;
        const value = Array.isArray(item.result)
          ? item.result[0]?.value
          : item.result?.value;

        if (value !== undefined && value !== null) {
          result[key] = value;
        }
      }

      this.recordRequest();
      logger.debug({ results: Object.keys(result) }, 'TaAPI bulk response parsed');
      return result;
    } catch (error) {
      logger.error({ error }, 'TaAPI bulk fetch failed');
      return null;
    }
  }

  // ============================================
  // CACHE
  // ============================================

  private tryFillFromCache(symbol: string, snapshot: IndicatorSnapshot): boolean {
    let allFilled = true;

    const ema = this.getCached(`${symbol}:ema:4h`);
    if (ema !== null) snapshot.ema200_4h = ema;
    else allFilled = false;

    const atr = this.getCached(`${symbol}:atr:4h`);
    if (atr !== null) snapshot.atr14_4h = atr;
    else allFilled = false;

    const rsi15m = this.getCached(`${symbol}:rsi:15m`);
    if (rsi15m !== null) snapshot.rsi15m = rsi15m;
    else allFilled = false;

    const rsi1h = this.getCached(`${symbol}:rsi:1h`);
    if (rsi1h !== null) snapshot.rsi1h = rsi1h;
    else allFilled = false;

    const vol = this.getCached(`${symbol}:volratio:1h`);
    if (vol !== null) snapshot.volumeRatio = vol;

    return allFilled;
  }

  private getCached(key: string): number | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCache(key: string, value: number): void {
    this.cache.set(key, { value, fetchedAt: Date.now() });
  }

  private recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  private async waitForRateLimit(): Promise<void> {
    const windowMs = 15000; // 15 seconds
    const now = Date.now();

    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < windowMs
    );

    if (this.requestTimestamps.length >= this.rateLimitPerWindow) {
      const oldest = this.requestTimestamps[0];
      const waitMs = windowMs - (now - oldest) + 100; // +100ms buffer
      logger.debug({ waitMs }, 'Rate limit reached, waiting');
      await sleep(waitMs);
    }
  }
}

export const indicatorService = new IndicatorService();
