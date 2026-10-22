package ledger_test

// Hidden acceptance (p3): contract v3 in ledger-go, and balances in the settlement currency.

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"shopflow.test/ledger-go/ledger"
)

const hiddenV3 = `{"contract_version":3,"order_id":"O-31","account_id":"A-31","account_tier":"vip","currency":"USD","settlement_currency":"VND","fx_rate_ppm":25350000,"items":[{"sku":"S1","qty":3,"unit_price":1999}]}`

func hiddenCode(payload string) string {
	_, err := ledger.ParseOrder([]byte(payload))
	var ce *ledger.ContractError
	if errors.As(err, &ce) {
		return ce.Code
	}
	return ""
}

func TestHiddenV3Read(t *testing.T) {
	o, err := ledger.ParseOrder([]byte(hiddenV3))
	if err != nil {
		t.Fatal(err)
	}
	if o.SourceVersion != 3 || o.SettlementCurrency != "VND" || o.FxRatePPM != 25350000 {
		t.Fatalf("got %+v", o)
	}
	if got := ledger.SettlementTotal(o); got != 5398*25350000/1000000 {
		t.Fatalf("SettlementTotal = %d", got)
	}
	out, err := ledger.MarshalOrder(o)
	if err != nil || string(out) != hiddenV3 {
		t.Fatalf("MarshalOrder = %s %v", out, err)
	}
	same := strings.Replace(strings.Replace(hiddenV3, `"settlement_currency":"VND"`, `"settlement_currency":"USD"`, 1), `"fx_rate_ppm":25350000`, `"fx_rate_ppm":1000000`, 1)
	o2, err := ledger.ParseOrder([]byte(same))
	if err != nil {
		t.Fatal(err)
	}
	out, _ = ledger.MarshalOrder(o2)
	if string(out) != `{"contract_version":2,"order_id":"O-31","account_id":"A-31","account_tier":"vip","currency":"USD","items":[{"sku":"S1","qty":3,"unit_price":1999}]}` {
		t.Fatalf("same-currency v3 should be written as v2: %s", out)
	}
	v2, _ := ledger.ParseOrder([]byte(`{"contract_version":2,"order_id":"O","account_id":"A","account_tier":"gold","currency":"EUR","items":[{"sku":"S","qty":1,"unit_price":10}]}`))
	if v2.SettlementCurrency != "EUR" || v2.FxRatePPM != 1000000 {
		t.Fatalf("v2 settlement defaults: %+v", v2)
	}
}

func TestHiddenV3Codes(t *testing.T) {
	cases := map[string]string{
		strings.Replace(hiddenV3, `"fx_rate_ppm":25350000`, `"fx_rate_ppm":0`, 1):                                                                                           "INVALID",
		strings.Replace(hiddenV3, `"fx_rate_ppm":25350000`, `"fx_rate_ppm":1000000001`, 1):                                                                                  "INVALID",
		strings.Replace(hiddenV3, `"fx_rate_ppm":25350000`, `"fx_rate_ppm":"25350000"`, 1):                                                                                  "INVALID",
		strings.Replace(hiddenV3, `"settlement_currency":"VND"`, `"settlement_currency":"USD"`, 1):                                                                          "INVALID",
		strings.Replace(hiddenV3, `"contract_version":3`, `"contract_version":4`, 1):                                                                                        "UNSUPPORTED_VERSION",
		strings.Replace(hiddenV3, `"account_id":"A-31"`, `"account_id":"A-31","customer_id":"C"`, 1):                                                                        "MIXED_FIELDS",
		`{"contract_version":2,"order_id":"O","account_id":"A","account_tier":"gold","currency":"EUR","fx_rate_ppm":1000000,"items":[{"sku":"S","qty":1,"unit_price":10}]}`: "MIXED_FIELDS",
	}
	for payload, want := range cases {
		if got := hiddenCode(payload); got != want {
			t.Errorf("%s: got %q want %q", payload, got, want)
		}
	}
	big := `{"contract_version":3,"order_id":"O","account_id":"A","account_tier":"standard","currency":"VND","settlement_currency":"JPY","fx_rate_ppm":796870377,"items":[{"sku":"B","qty":1,"unit_price":424946923}]}`
	o, err := ledger.ParseOrder([]byte(big))
	if err != nil || ledger.SettlementTotal(o) != 338627614735 {
		t.Fatalf("big settlement: %v %v", ledger.SettlementTotal(o), err)
	}
}

func TestHiddenV3Balances(t *testing.T) {
	events := strings.Join([]string{
		`{"event_id":"E1","type":"order.placed","order":` + hiddenV3 + `}`,
		`{"event_id":"E2","type":"order.placed","order":{"contract_version":2,"order_id":"O2","account_id":"A-31","account_tier":"gold","currency":"VND","items":[{"sku":"S","qty":2,"unit_price":50000}]}}`,
		`{"event_id":"E3","type":"order.refunded","order":{"contract_version":3,"order_id":"O3","account_id":"A-31","account_tier":"standard","currency":"EUR","settlement_currency":"VND","fx_rate_ppm":27000000000,"items":[{"sku":"S","qty":1,"unit_price":100}]}}`,
		`{"event_id":"E4","type":"order.placed","order":{"contract_version":3,"order_id":"O4","account_id":"A-32","account_tier":"standard","currency":"EUR","settlement_currency":"USD","fx_rate_ppm":1083000,"items":[{"sku":"S","qty":7,"unit_price":999}]}}`,
		`{"event_id":"E5","type":"order.placed","order":{"order_id":"O5","customer_id":"A-32","customer_tier":"vip","currency":"USD","items":[{"sku":"S","qty":1,"unit_price":1000}]}}`,
	}, "\n")
	report, err := ledger.Process(strings.NewReader(events))
	if err != nil {
		t.Fatal(err)
	}
	want := []ledger.Balance{
		{AccountID: "A-31", Currency: "VND", Balance: 5398*25350000/1000000 + 95000},
		{AccountID: "A-32", Currency: "USD", Balance: 6993*1083000/1000000 + 900},
	}
	if !reflect.DeepEqual(report.Balances, want) || report.Accepted != 4 || len(report.Rejected) != 1 || report.Rejected[0].Code != "INVALID" {
		t.Fatalf("got %+v\nwant balances %+v (E3 has an out-of-range fx_rate_ppm)", report, want)
	}
}
