package ledger

import (
	"errors"
	"testing"
)

const v2 = `{"contract_version":2,"order_id":"O-1","account_id":"A-1","account_tier":"gold","currency":"VND","items":[{"sku":"TEA-01","qty":3,"unit_price":45000}]}`

func codeOf(t *testing.T, payload string) string {
	t.Helper()
	_, err := ParseOrder([]byte(payload))
	var ce *ContractError
	if err == nil {
		return ""
	}
	if !errors.As(err, &ce) {
		t.Fatalf("not a ContractError: %v", err)
	}
	return ce.Code
}

func TestParseV2(t *testing.T) {
	o, err := ParseOrder([]byte(v2))
	if err != nil {
		t.Fatal(err)
	}
	if o.AccountID != "A-1" || o.AccountTier != "gold" || o.SourceVersion != 2 || len(o.Items) != 1 || o.Items[0].UnitPrice != 45000 {
		t.Fatalf("unexpected order %+v", o)
	}
	q := QuoteOrder(o)
	if q.Subtotal != 135000 || q.Discount != 6750 || q.Total != 128250 {
		t.Fatalf("unexpected quote %+v", q)
	}
}

func TestErrorCodes(t *testing.T) {
	cases := map[string]string{
		`{"contract_version":4,"order_id":"O","account_id":"A","account_tier":"gold","currency":"VND","items":[{"sku":"A","qty":1,"unit_price":1}]}`:    "UNSUPPORTED_VERSION",
		`{"contract_version":"2","order_id":"O","account_id":"A","account_tier":"gold","currency":"VND","items":[{"sku":"A","qty":1,"unit_price":1}]}`:  "UNSUPPORTED_VERSION",
		`{"contract_version":2,"order_id":"O","account_id":"A","account_tier":"gold","currency":"US1","items":[{"sku":"A","qty":1,"unit_price":1}]}`:    "INVALID",
		`{"contract_version":2,"order_id":"O","account_id":"A","account_tier":"gold","currency":"VND","items":[{"sku":"A","qty":1.5,"unit_price":1}]}`:  "INVALID",
		`{"contract_version":2,"order_id":"O","account_id":"A","account_tier":"gold","currency":"VND","items":[{"sku":"A","qty":true,"unit_price":1}]}`: "INVALID",
		`[1,2]`:    "INVALID",
		`not json`: "INVALID",
	}
	for payload, want := range cases {
		if got := codeOf(t, payload); got != want {
			t.Errorf("%s: got %q want %q", payload, got, want)
		}
	}
}

func TestMarshalOrderKeyOrder(t *testing.T) {
	o, err := ParseOrder([]byte(v2))
	if err != nil {
		t.Fatal(err)
	}
	out, err := MarshalOrder(o)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != v2 {
		t.Fatalf("got %s", out)
	}
}
