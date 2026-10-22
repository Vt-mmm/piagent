import { toWire } from './order.js';

// The request web-js sends to the Account API for a quote.
export function buildQuoteRequest(order, env = process.env) {
  const base = env.ACCOUNT_API_URL;
  if (!base) throw new Error('ACCOUNT_API_URL is not set');
  return {
    method: 'POST',
    url: `${base.replace(/\/+$/, '')}/accounts/${encodeURIComponent(order.accountId)}/quotes`,
    headers: { 'content-type': 'application/json' },
    body: toWire(order),
  };
}
