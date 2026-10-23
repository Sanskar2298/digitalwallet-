import { pool } from '../../config/database';
import { BadRequestError } from '../../utils/errors';

export interface ExchangeRateRecord {
  id: string;
  base_currency: string;
  target_currency: string;
  rate: string;
  updated_at: Date;
}

export class FxService {
  /**
   * Get exchange rate from baseCurrency to targetCurrency.
   * If currencies are identical, returns 1.0.
   */
  async getRate(baseCurrency: string, targetCurrency: string): Promise<number> {
    const base = baseCurrency.toUpperCase();
    const target = targetCurrency.toUpperCase();

    if (base === target) {
      return 1.0;
    }

    // Check direct rate
    const direct = await pool.query<ExchangeRateRecord>(
      `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,
      [base, target]
    );

    if (direct.rowCount && direct.rowCount > 0) {
      return parseFloat(direct.rows[0].rate);
    }

    // Check inverse rate
    const inverse = await pool.query<ExchangeRateRecord>(
      `SELECT rate FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2`,
      [target, base]
    );

    if (inverse.rowCount && inverse.rowCount > 0) {
      const inverseRate = parseFloat(inverse.rows[0].rate);
      return Math.round((1 / inverseRate) * 1000000) / 1000000;
    }

    throw new BadRequestError(`No exchange rate found for currency pair ${base}/${target}`);
  }

  /**
   * ISO 4217 Currency decimal exponents (e.g. USD=2, JPY=0, BHD=3)
   */
  private readonly currencyDecimals: Record<string, number> = {
    USD: 2,
    EUR: 2,
    GBP: 2,
    CAD: 2,
    AUD: 2,
    CHF: 2,
    JPY: 0,
    KRW: 0,
    BHD: 3,
    KWD: 3,
  };

  /**
   * Get decimal exponent for currency, default 2
   */
  getCurrencyDecimals(currency: string): number {
    const curr = currency.toUpperCase();
    return this.currencyDecimals[curr] !== undefined ? this.currencyDecimals[curr] : 2;
  }

  /**
   * Convert an amount in minor units from one currency to another using current FX rates
   * and ISO 4217 minor-unit exponents.
   */
  async convert(amount: number, fromCurrency: string, toCurrency: string): Promise<{
    rate: number;
    destinationAmount: number;
    fromDecimals: number;
    toDecimals: number;
  }> {
    const rate = await this.getRate(fromCurrency, toCurrency);
    const fromDecimals = this.getCurrencyDecimals(fromCurrency);
    const toDecimals = this.getCurrencyDecimals(toCurrency);

    // Scaling factor = 10^(toDecimals - fromDecimals)
    // E.g., USD (2) to JPY (0) -> 10^(0 - 2) = 0.01
    // E.g., JPY (0) to USD (2) -> 10^(2 - 0) = 100
    const exponentAdjustment = Math.pow(10, toDecimals - fromDecimals);
    const destinationAmount = Math.round(amount * rate * exponentAdjustment);

    return { rate, destinationAmount, fromDecimals, toDecimals };
  }

  /**
   * List all available FX rates
   */
  async listRates() {
    const res = await pool.query<ExchangeRateRecord>(
      `SELECT base_currency, target_currency, rate, updated_at FROM exchange_rates ORDER BY base_currency, target_currency`
    );
    return res.rows.map((r) => ({
      baseCurrency: r.base_currency,
      targetCurrency: r.target_currency,
      rate: parseFloat(r.rate),
      updatedAt: r.updated_at,
    }));
  }
}

export const fxService = new FxService();
