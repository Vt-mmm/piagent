// Compat shim for legacy v1 order payloads (customer_id / customer_tier).
// Readers accept v1 payloads for the whole 2.x line; this shim goes away in 3.0.0.
export const LEGACY_FIELDS = Object.freeze({ customer_id: 'account_id', customer_tier: 'account_tier' });

// v1: contract_version 1, or no contract_version at all.
export const isV1 = data => !('contract_version' in data) || data.contract_version === 1;

// A new v2 object for a v1 payload; the input is left unchanged.
export function upgradeV1(data) {
  const upgraded = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'contract_version') continue;
    upgraded[LEGACY_FIELDS[key] ?? key] = value;
  }
  upgraded.contract_version = 2;
  return upgraded;
}
