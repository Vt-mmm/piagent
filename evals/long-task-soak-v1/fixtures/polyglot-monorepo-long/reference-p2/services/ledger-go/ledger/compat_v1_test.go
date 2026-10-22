package ledger

import "testing"

func TestLegacyV1(t *testing.T) {
	o, err := ParseOrder([]byte(`{"order_id":"O-2","customer_id":"C-2","customer_tier":"vip","currency":"USD","items":[{"sku":"A","qty":7,"unit_price":1999}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if o.AccountID != "C-2" || o.AccountTier != "vip" || o.SourceVersion != 1 {
		t.Fatalf("unexpected %+v", o)
	}
	out, _ := MarshalOrder(o)
	if string(out) != `{"contract_version":2,"order_id":"O-2","account_id":"C-2","account_tier":"vip","currency":"USD","items":[{"sku":"A","qty":7,"unit_price":1999}]}` {
		t.Fatalf("writer did not write v2: %s", out)
	}
	if got := codeOf(t, `{"contract_version":1,"order_id":"O","customer_id":"C","account_id":"A","customer_tier":"vip","currency":"USD","items":[{"sku":"A","qty":1,"unit_price":1}]}`); got != "MIXED_FIELDS" {
		t.Fatalf("got %q", got)
	}
	if got := codeOf(t, `{"contract_version":2,"order_id":"O","customer_id":"C","account_id":"A","account_tier":"vip","currency":"USD","items":[{"sku":"A","qty":1,"unit_price":1}]}`); got != "MIXED_FIELDS" {
		t.Fatalf("got %q", got)
	}
}
