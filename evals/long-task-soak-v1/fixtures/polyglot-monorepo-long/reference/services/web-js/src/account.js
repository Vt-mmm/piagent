// Accounts as the Account API returns them.
export const ACCOUNT_TIERS = Object.freeze(['standard', 'gold', 'vip']);

export function normalizeAccount(raw) {
  if (!raw || typeof raw.account_id !== 'string' || !raw.account_id) throw new TypeError('account_id is required');
  const tier = raw.tier ?? 'standard';
  if (!ACCOUNT_TIERS.includes(tier)) throw new TypeError(`unknown account tier: ${tier}`);
  return { accountId: raw.account_id, name: String(raw.name ?? '').trim(), tier };
}

// "Leaf & Co (GOLD)"; an account without a name shows its id.
export function accountLabel(account) {
  return `${account.name || account.accountId} (${account.tier.toUpperCase()})`;
}
