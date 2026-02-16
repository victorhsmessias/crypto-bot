import { config } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { prisma } from '../lib/prisma.js';
import type { Decimal } from '../utils/constants.js';
import type { NotificationType, NotificationPayload } from '../types/index.js';

const logger = createChildLogger({ service: 'NotificationService' });

export class NotificationService {
  private enabled: boolean;
  private botToken: string;
  private chatId: string;

  constructor() {
    this.enabled = config.TELEGRAM_ENABLED;
    this.botToken = config.TELEGRAM_BOT_TOKEN;
    this.chatId = config.TELEGRAM_CHAT_ID;

    if (this.enabled && (!this.botToken || !this.chatId)) {
      logger.warn('Telegram enabled but token or chat ID missing, disabling');
      this.enabled = false;
    }
  }

  async notify(payload: NotificationPayload): Promise<void> {
    const message = this.formatMessage(payload);

    // Always log to database
    try {
      const sent = this.enabled ? await this.sendTelegram(message) : false;
      await prisma.notificationLog.create({
        data: {
          type: payload.type,
          symbol: payload.symbol ?? null,
          message,
          sent,
        },
      });
    } catch (error) {
      logger.error({ error, type: payload.type }, 'Failed to process notification');
    }
  }

  async notifyCycleStart(symbol: string, price: Decimal, rsi: number): Promise<void> {
    await this.notify({
      type: 'CYCLE_START' as NotificationType,
      symbol,
      message: `*CYCLE START* | ${symbol}\nPrice: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(1)}`,
    });
  }

  async notifyCycleEnd(symbol: string, profit: Decimal, profitPercent: Decimal): Promise<void> {
    const emoji = profit.isPositive() ? '🟢' : '🔴';
    await this.notify({
      type: 'CYCLE_END' as NotificationType,
      symbol,
      message: `*CYCLE END* ${emoji} | ${symbol}\nProfit: $${profit.toFixed(2)} (${profitPercent.toFixed(2)}%)`,
    });
  }

  async notifyBuy(symbol: string, price: Decimal, amount: Decimal, buyNumber: number): Promise<void> {
    const label = buyNumber === 1 ? 'INITIAL BUY' : `DCA BUY #${buyNumber}`;
    await this.notify({
      type: 'BUY' as NotificationType,
      symbol,
      message: `*${label}* | ${symbol}\nPrice: $${price.toFixed(2)}\nAmount: $${amount.toFixed(2)}`,
    });
  }

  async notifyPartialSell(symbol: string, price: Decimal, quantity: Decimal, percent: number): Promise<void> {
    await this.notify({
      type: 'PARTIAL_SELL' as NotificationType,
      symbol,
      message: `*PARTIAL SELL* (${(percent * 100).toFixed(0)}%) | ${symbol}\nPrice: $${price.toFixed(2)}\nQty: ${quantity.toFixed(8)}`,
    });
  }

  async notifyTrailingSell(symbol: string, price: Decimal, quantity: Decimal): Promise<void> {
    await this.notify({
      type: 'TRAILING_TRIGGERED' as NotificationType,
      symbol,
      message: `*TRAILING STOP* triggered | ${symbol}\nPrice: $${price.toFixed(2)}\nQty: ${quantity.toFixed(8)}`,
    });
  }

  async notifyDrawdownWarning(currentDrawdown: Decimal): Promise<void> {
    await this.notify({
      type: 'DRAWDOWN_WARNING' as NotificationType,
      message: `*DRAWDOWN WARNING*\nCurrent: ${currentDrawdown.times(100).toFixed(2)}%\nMax allowed: ${(config.RISK_MAX_DRAWDOWN * 100).toFixed(0)}%`,
    });
  }

  async notifyBotPaused(reason: string): Promise<void> {
    await this.notify({
      type: 'BOT_PAUSED' as NotificationType,
      message: `*BOT PAUSED*\nReason: ${reason}\nManual intervention may be required.`,
    });
  }

  async notifyBotResumed(): Promise<void> {
    await this.notify({
      type: 'BOT_RESUMED' as NotificationType,
      message: `*BOT RESUMED*\nTrading operations restored.`,
    });
  }

  async notifyCrashDetected(symbol: string, dropPercent: Decimal): Promise<void> {
    await this.notify({
      type: 'CRASH_DETECTED' as NotificationType,
      symbol,
      message: `*CRASH DETECTED* | ${symbol}\nDrop: ${dropPercent.times(100).toFixed(2)}% in ${config.RISK_CRASH_TIME_WINDOW_MINUTES / 60}h\nNew buys suspended.`,
    });
  }

  async notifyLateralDetected(symbol: string): Promise<void> {
    await this.notify({
      type: 'LATERAL_DETECTED' as NotificationType,
      symbol,
      message: `*LATERAL MARKET* | ${symbol}\n${config.RISK_LATERAL_CYCLE_COUNT} consecutive low-profit cycles.\nPaused for ${config.RISK_LATERAL_PAUSE_HOURS}h.`,
    });
  }

  private async sendTelegram(text: string): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        logger.error({ error }, 'Telegram API error');
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to send Telegram message');
      return false;
    }
  }

  private formatMessage(payload: NotificationPayload): string {
    return payload.message;
  }
}

export const notificationService = new NotificationService();
