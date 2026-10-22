import { USD_RATE_VND } from '../data.js';
import { fail } from '../http.js';
import { groupDigits, padLeft } from './text.js';

/** VND: 1.234.000 ₫   USD (amount in cents): $1,234.50 */
export function formatMoney(amount, currency) {
  const abs = Math.abs(amount);
  let text;
  if (currency === 'USD') {
    text = '$' + groupDigits(String(Math.floor(abs / 100)), ',') + '.' + padLeft(abs % 100, 2, '0');
  } else {
    text = groupDigits(String(abs), '.') + ' ₫';
  }
  return amount < 0 ? '-' + text : text;
}

// USD amounts are cents, rounded half up.
export function vndToCurrency(amountVnd, currency) {
  return currency === 'USD' ? Math.floor((amountVnd * 100) / USD_RATE_VND + 0.5) : amountVnd;
}

export function readCurrency(value) {
  if (value === undefined || value === null || value === '') return 'VND';
  const c = String(value).toUpperCase();
  if (c !== 'VND' && c !== 'USD') fail(400, 'bad_currency', value);
  return c;
}
