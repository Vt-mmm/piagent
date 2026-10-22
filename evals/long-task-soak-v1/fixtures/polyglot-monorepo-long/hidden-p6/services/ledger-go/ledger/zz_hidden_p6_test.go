package ledger_test

// Hidden acceptance (p6): account_id with leading/trailing whitespace is INVALID
// in every version, and padded ids are rejected by Process; release 3.0.0.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"shopflow.test/ledger-go/ledger"
)

func p6Code(payload map[string]any) string {
	data, _ := json.Marshal(payload)
	_, err := ledger.ParseOrder(data)
	var ce *ledger.ContractError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return ""
}

func p6Payload(version int, id string) map[string]any {
	items := []any{map[string]any{"sku": "S", "qty": 1, "unit_price": 100}}
	switch version {
	case 1:
		return map[string]any{"contract_version": 1, "order_id": "O", "customer" + "_id": id, "customer" + "_tier": "gold", "currency": "VND", "items": items}
	case 3:
		return map[string]any{"contract_version": 3, "order_id": "O", "account_id": id, "account_tier": "gold", "currency": "USD", "settlement_currency": "VND", "fx_rate_ppm": 25000000, "items": items}
	}
	return map[string]any{"contract_version": 2, "order_id": "O", "account_id": id, "account_tier": "gold", "currency": "VND", "items": items}
}

func TestHiddenPaddedAccountID(t *testing.T) {
	for _, bad := range []string{" A-1", "A-1 ", "  A-1  ", "\tA-1", "A-1\n"} {
		for _, v := range []int{1, 2, 3} {
			if got := p6Code(p6Payload(v, bad)); got != "INVALID" {
				t.Errorf("v%d %q: got %q want INVALID", v, bad, got)
			}
		}
	}
	for _, good := range []string{"A-1", "A 1", "Đ-1"} {
		if got := p6Code(p6Payload(2, good)); got != "" {
			t.Errorf("%q: unexpected %q", good, got)
		}
	}
	report, err := ledger.Process(strings.NewReader(`{"event_id":"E1","type":"order.placed","order":{"contract_version":2,"order_id":"O","account_id":"A-1 ","account_tier":"gold","currency":"VND","items":[{"sku":"S","qty":1,"unit_price":100}]}}`))
	if err != nil || report.Accepted != 0 || len(report.Rejected) != 1 || report.Rejected[0].Code != "INVALID" {
		t.Fatalf("Process with a padded id: %+v %v", report, err)
	}
}

func TestHiddenVersion(t *testing.T) {
	if ledger.Version != "3.0.0" {
		t.Fatalf("ledger.Version = %q", ledger.Version)
	}
}
