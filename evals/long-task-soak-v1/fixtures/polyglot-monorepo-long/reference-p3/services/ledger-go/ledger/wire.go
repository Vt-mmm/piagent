package ledger

import (
	"bytes"
	"encoding/json"
)

type field struct {
	key   string
	value any
}

type wireItem struct {
	SKU       string `json:"sku"`
	Qty       int64  `json:"qty"`
	UnitPrice int64  `json:"unit_price"`
}

// Converts reports whether the order settles in another currency or at a
// non-identity rate (and so needs contract v3 on the wire).
func (o Order) Converts() bool {
	settlement := o.SettlementCurrency
	if settlement == "" {
		settlement = o.Currency
	}
	rate := o.FxRatePPM
	if rate == 0 {
		rate = PPM
	}
	return settlement != o.Currency || rate != PPM
}

// MarshalOrder writes the lowest contract version that carries the order,
// keys in schema order: v2 (contract_version, order_id, account_id,
// account_tier, currency, items), or v3 with settlement_currency and
// fx_rate_ppm before items.
func MarshalOrder(o Order) ([]byte, error) {
	items := make([]wireItem, len(o.Items))
	for i, it := range o.Items {
		items[i] = wireItem{it.SKU, it.Qty, it.UnitPrice}
	}
	version := ContractVersion
	if o.Converts() {
		version = LatestVersion
	}
	fields := []field{
		{"contract_version", version},
		{"order_id", o.OrderID},
		{"account_id", o.AccountID},
		{"account_tier", o.AccountTier},
		{"currency", o.Currency},
	}
	if o.Converts() {
		fields = append(fields, field{"settlement_currency", o.SettlementCurrency}, field{"fx_rate_ppm", o.FxRatePPM})
	}
	return marshalFields(append(fields, field{"items", items}))
}

func marshalFields(fields []field) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			buf.WriteByte(',')
		}
		key, _ := json.Marshal(f.key)
		value, err := json.Marshal(f.value)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}
