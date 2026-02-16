import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { Decimal } from '../utils/constants.js';
import type { Decimal as DecimalType } from '../utils/constants.js';
import { exchangeService } from './exchange.service.js';

const logger = createChildLogger({ service: 'CapitalManager' });

export class CapitalManagerService {
  private quoteCurrency: string;

  constructor() {
    this.quoteCurrency = 'USDT';
  }

  async getAvailableBalance(): Promise<DecimalType> {
    const balance = await exchangeService.getBalance(this.quoteCurrency);
    logger.debug({ balance: balance.toString() }, 'Available balance');
    return balance;
  }

  async getTotalBalance(): Promise<DecimalType> {
    return exchangeService.getTotalBalanceInUSDT(config.TRADING_SYMBOLS);
  }

  calculateEntrySize(totalBalance: DecimalType): DecimalType {
    const entryPercent = new Decimal(config.CAPITAL_ENTRY_PERCENT);
    return totalBalance.times(entryPercent);
  }

  calculateMaxExposure(totalBalance: DecimalType): DecimalType {
    const maxExposure = new Decimal(config.CAPITAL_MAX_EXPOSURE);
    return totalBalance.times(maxExposure);
  }

  async canExecuteBuy(
    totalBalance: DecimalType,
    currentCycleInvested: DecimalType,
    symbol: string
  ): Promise<{ canBuy: boolean; reason?: string; amount?: DecimalType }> {
    const entrySize = this.calculateEntrySize(totalBalance);
    const maxExposure = this.calculateMaxExposure(totalBalance);

    // Check exposure limit
    const projectedExposure = currentCycleInvested.plus(entrySize);
    if (projectedExposure.greaterThan(maxExposure)) {
      return {
        canBuy: false,
        reason: `Exposure limit: ${projectedExposure.toFixed(2)} > max ${maxExposure.toFixed(2)}`,
      };
    }

    // Check minimum order size
    const minOrderSize = await exchangeService.getMinOrderSize(symbol);
    if (entrySize.lessThan(minOrderSize)) {
      return {
        canBuy: false,
        reason: `Entry size ${entrySize.toFixed(2)} below minimum ${minOrderSize.toFixed(2)}`,
      };
    }

    // Check available balance
    const available = await this.getAvailableBalance();
    if (available.lessThan(entrySize)) {
      return {
        canBuy: false,
        reason: `Insufficient balance: ${available.toFixed(2)} < ${entrySize.toFixed(2)}`,
      };
    }

    logger.debug(
      {
        entrySize: entrySize.toString(),
        currentExposure: currentCycleInvested.toString(),
        maxExposure: maxExposure.toString(),
      },
      'Buy validation passed'
    );

    return { canBuy: true, amount: entrySize };
  }

  formatCurrency(value: DecimalType, currency?: string): string {
    return `${value.toFixed(2)} ${currency ?? this.quoteCurrency}`;
  }
}

export const capitalManager = new CapitalManagerService();
