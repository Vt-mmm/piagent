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

// MarshalOrder writes the v2 wire payload, keys in schema order
// (contract_version, order_id, account_id, account_tier, currency, items).
func MarshalOrder(o Order) ([]byte, error) {
	items := make([]wireItem, len(o.Items))
	for i, it := range o.Items {
		items[i] = wireItem{it.SKU, it.Qty, it.UnitPrice}
	}
	return marshalFields([]field{
		{"contract_version", ContractVersion},
		{"order_id", o.OrderID},
		{"account_id", o.AccountID},
		{"account_tier", o.AccountTier},
		{"currency", o.Currency},
		{"items", items},
	})
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
