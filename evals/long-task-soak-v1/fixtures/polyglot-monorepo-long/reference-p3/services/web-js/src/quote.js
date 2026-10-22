// Quotes, the same rule as pricing-py's quote(): integer amounts, tier discount rounded down.
import { PPM } from './order.js';

const DISCOUNT_PERCENT = Object.freeze({ standard: 0, gold: 5, vip: 10 });

export function quoteOrder(order) {
  const subtotal = order.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const discount = Math.floor((subtotal * DISCOUNT_PERCENT[order.accountTier]) / 100);
  return { orderId: order.orderId, accountId: order.accountId, currency: order.currency, subtotal, discount, total: subtotal - discount };
}

// total × fx_rate_ppm / 1 000 000 rounded down, exact even when the product passes 2^53.
export function settlementTotal(order) {
  const total = BigInt(quoteOrder(order).total);
  return Number((total * BigInt(order.fxRatePpm ?? PPM)) / BigInt(PPM));
}
