// Customers as the Customer API returns them.
export const CUSTOMER_TIERS = Object.freeze(['standard', 'gold', 'vip']);

export function normalizeCustomer(raw) {
  if (!raw || typeof raw.customer_id !== 'string' || !raw.customer_id) throw new TypeError('customer_id is required');
  const tier = raw.tier ?? 'standard';
  if (!CUSTOMER_TIERS.includes(tier)) throw new TypeError(`unknown customer tier: ${tier}`);
  return { customerId: raw.customer_id, name: String(raw.name ?? '').trim(), tier };
}

// "Leaf & Co (GOLD)"; a customer without a name shows its id.
export function customerLabel(customer) {
  return `${customer.name || customer.customerId} (${customer.tier.toUpperCase()})`;
}
