package ledger

import "encoding/json"

// Compat shim for legacy v1 order payloads (customer_id / customer_tier).
// Readers accept v1 payloads for the whole 2.x line.

var legacyFields = map[string]string{"customer_id": "account_id", "customer_tier": "account_tier"}

var newFields = []string{"account_id", "account_tier"}

func legacyFieldNames() []string { return []string{"customer_id", "customer_tier"} }

// isV1: contract_version 1, or no contract_version at all.
func isV1(obj map[string]any) bool {
	v, present := obj["contract_version"]
	if !present {
		return true
	}
	n, ok := intValue(v)
	return ok && n == 1
}

// upgradeV1 returns a new v2 object for a v1 payload; the input is left unchanged.
func upgradeV1(obj map[string]any) map[string]any {
	out := make(map[string]any, len(obj))
	for k, v := range obj {
		if k == "contract_version" {
			continue
		}
		if renamed, ok := legacyFields[k]; ok {
			k = renamed
		}
		out[k] = v
	}
	out["contract_version"] = json.Number("2")
	return out
}
