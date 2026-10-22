import { toWire } from './order.js';

// The request web-js sends to the Customer API for a quote.
export function buildQuoteRequest(order, env = process.env) {
  const base = env.CUSTOMER_API_URL;
  if (!base) throw new Error('CUSTOMER_API_URL is not set');
  return {
    method: 'POST',
    url: `${base.replace(/\/+$/, '')}/customers/${encodeURIComponent(order.customerId)}/quotes`,
    headers: { 'content-type': 'application/json' },
    body: toWire(order),
  };
}
