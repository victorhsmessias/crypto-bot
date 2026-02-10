import Decimal from 'decimal.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { TRADING } from '../utils/constants.js';
import { exchangeService } from './exchange.service.js';

const logger = createChildLogger({ service: 'CapitalManager' });

export class CapitalManagerService {
  private quoteCurrency: string;

  constructor() {
    // Extrai a moeda de cotação do símbolo (ex: BTC/USDT -> USDT)
    this.quoteCurrency = config.TRADING_SYMBOL.split('/')[1];
  }

  /**
   * Obtém o saldo disponível na exchange
   */
  async getAvailableBalance(): Promise<Decimal> {
    const balance = await exchangeService.getBalance(this.quoteCurrency);
    logger.debug({ balance: balance.toString() }, 'Available balance');
    return balance;
  }

  /**
   * Calcula o tamanho da posição baseado no percentual configurado
   * positionSize = balance * DCA_POSITION_SIZE (default 10%)
   */
  async calculatePositionSize(): Promise<Decimal> {
    const balance = await this.getAvailableBalance();
    const positionSizePercent = new Decimal(config.DCA_POSITION_SIZE);

    const positionSize = balance.times(positionSizePercent);

    logger.debug(
      {
        balance: balance.toString(),
        percent: positionSizePercent.toString(),
        positionSize: positionSize.toString(),
      },
      'Calculated position size'
    );

    return positionSize;
  }

  /**
   * Valida se há saldo suficiente para a ordem
   */
  async validateSufficientBalance(requiredAmount: Decimal): Promise<boolean> {
    const balance = await this.getAvailableBalance();
    const hasSufficient = balance.greaterThanOrEqualTo(requiredAmount);

    if (!hasSufficient) {
      logger.warn(
        {
          required: requiredAmount.toString(),
          available: balance.toString(),
        },
        'Insufficient balance for order'
      );
    }

    return hasSufficient;
  }

  /**
   * Valida se o valor da ordem atende ao mínimo da exchange
   */
  async validateMinOrderSize(orderValue: Decimal): Promise<boolean> {
    const minOrderSize = await exchangeService.getMinOrderSize(config.TRADING_SYMBOL);
    const isValid = orderValue.greaterThanOrEqualTo(minOrderSize);

    if (!isValid) {
      logger.warn(
        {
          orderValue: orderValue.toString(),
          minRequired: minOrderSize.toString(),
        },
        'Order value below minimum'
      );
    }

    return isValid;
  }

  /**
   * Valida todas as condições para uma compra
   */
  async canExecuteBuy(): Promise<{ canBuy: boolean; reason?: string; amount?: Decimal }> {
    const positionSize = await this.calculatePositionSize();

    // Verificar mínimo da exchange
    const meetsMinimum = await this.validateMinOrderSize(positionSize);
    if (!meetsMinimum) {
      return {
        canBuy: false,
        reason: `Position size ${positionSize.toString()} below minimum order value`,
      };
    }

    // Verificar saldo suficiente
    const hasSufficientBalance = await this.validateSufficientBalance(positionSize);
    if (!hasSufficientBalance) {
      return {
        canBuy: false,
        reason: 'Insufficient balance',
      };
    }

    return {
      canBuy: true,
      amount: positionSize,
    };
  }

  /**
   * Formata valor para exibição
   */
  formatCurrency(value: Decimal): string {
    return `${value.toFixed(2)} ${this.quoteCurrency}`;
  }
}

// Export singleton
export const capitalManager = new CapitalManagerService();
