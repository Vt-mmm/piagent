package ledger_test

// Hidden acceptance (p2): the Go reader agrees with the shared vectors, the
// writer keeps schema key order, and Process books events as specified.

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"shopflow.test/ledger-go/ledger"
)

type hiddenVector struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
	Expect  struct {
		Error string         `json:"error"`
		OK    map[string]any `json:"ok"`
	} `json:"expect"`
}

func TestHiddenVectors(t *testing.T) {
	data, err := os.ReadFile("../../../.soak/p2/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []hiddenVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		order, err := ledger.ParseOrder(v.Payload)
		if v.Expect.Error != "" {
			var ce *ledger.ContractError
			if !errors.As(err, &ce) || ce.Code != v.Expect.Error {
				t.Errorf("%s: got %v, want code %s", v.Name, err, v.Expect.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: unexpected error %v", v.Name, err)
			continue
		}
		q := ledger.QuoteOrder(order)
		got := map[string]any{
			"source_version": float64(order.SourceVersion), "account_id": order.AccountID, "account_tier": order.AccountTier,
			"currency": order.Currency, "subtotal": float64(q.Subtotal), "discount": float64(q.Discount), "total": float64(q.Total),
		}
		for k, want := range v.Expect.OK {
			if got[k] != want {
				t.Errorf("%s: %s = %v, want %v", v.Name, k, got[k], want)
			}
		}
	}
}

func TestHiddenWriterKeyOrder(t *testing.T) {
	legacy := `{"order_id":"O-8","customer_tier":"vip","customer_id":"C-8","currency":"USD","items":[{"unit_price":1999,"qty":2,"sku":"S1"}]}`
	order, err := ledger.ParseOrder([]byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	out, err := ledger.MarshalOrder(order)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"contract_version":2,"order_id":"O-8","account_id":"C-8","account_tier":"vip","currency":"USD","items":[{"sku":"S1","qty":2,"unit_price":1999}]}`
	if string(out) != want {
		t.Fatalf("MarshalOrder:\n got %s\nwant %s", out, want)
	}
}

func TestHiddenProcess(t *testing.T) {
	events := strings.Join([]string{
		`{"event_id":"E1","type":"order.placed","order":{"contract_version":2,"order_id":"O1","account_id":"B-2","account_tier":"vip","currency":"VND","items":[{"sku":"A","qty":3,"unit_price":33333}]}}`,
		`{"event_id":"E2","type":"order.placed","order":{"order_id":"O2","customer_id":"B-1","customer_tier":"gold","currency":"USD","items":[{"sku":"A","qty":1,"unit_price":999}]}}`,
		``,
		`{"event_id":"E3","type":"order.refunded","order":{"contract_version":2,"order_id":"O1","account_id":"B-2","account_tier":"vip","currency":"VND","items":[{"sku":"A","qty":1,"unit_price":33333}]}}`,
		`{"event_id":"E1","type":"order.placed","order":{"contract_version":2,"order_id":"O9","account_id":"B-2","account_tier":"vip","currency":"VND","items":[{"sku":"A","qty":1,"unit_price":1}]}}`,
		`[1,2,3]`,
		`{"event_id":"E5","type":"order.shipped","order":{}}`,
		`{"type":"order.placed","order":{}}`,
		`{"event_id":"E6","type":"order.placed"}`,
		`{"event_id":"E7","type":"order.placed","order":{"contract_version":9}}`,
		`{"event_id":"E8","type":"order.placed","order":{"contract_version":2,"order_id":"O8","account_id":"B-1","customer_id":"B-1","account_tier":"gold","currency":"USD","items":[{"sku":"A","qty":1,"unit_price":1}]}}`,
		`{"event_id":"E9","type":"order.refunded","order":{"contract_version":2,"order_id":"O2","account_id":"B-1","account_tier":"standard","currency":"USD","items":[{"sku":"A","qty":2,"unit_price":999}]}}`,
		`{"event_id":"E7","type":"order.placed","order":{"contract_version":2,"order_id":"O7","account_id":"B-3","account_tier":"standard","currency":"EUR","items":[{"sku":"A","qty":1,"unit_price":0}]}}`,
		`{"event_id":"E10","type":"order.placed","order":{"contract_version":2,"order_id":"O10","account_id":"B-1","account_tier":"gold","currency":"VND","items":[{"sku":"A","qty":1,"unit_price":100}]}}`,
	}, "\n")
	report, err := ledger.Process(strings.NewReader(events))
	if err != nil {
		t.Fatal(err)
	}
	want := ledger.Report{
		Accepted: 6,
		Balances: []ledger.Balance{
			{AccountID: "B-1", Currency: "USD", Balance: 950 - 1998},
			{AccountID: "B-1", Currency: "VND", Balance: 95},
			{AccountID: "B-2", Currency: "VND", Balance: 90000 - 30000},
			{AccountID: "B-3", Currency: "EUR", Balance: 0},
		},
		Rejected: []ledger.Rejection{
			{Line: 5, EventID: "E1", Code: "DUPLICATE"},
			{Line: 6, EventID: "", Code: "BAD_JSON"},
			{Line: 7, EventID: "E5", Code: "UNKNOWN_TYPE"},
			{Line: 8, EventID: "", Code: "BAD_EVENT"},
			{Line: 9, EventID: "E6", Code: "BAD_EVENT"},
			{Line: 10, EventID: "E7", Code: "UNSUPPORTED_VERSION"},
			{Line: 11, EventID: "E8", Code: "MIXED_FIELDS"},
		},
	}
	if !reflect.DeepEqual(report, want) {
		t.Fatalf("Process:\n got %+v\nwant %+v", report, want)
	}
	data, _ := json.Marshal(report)
	var generic map[string]any
	_ = json.Unmarshal(data, &generic)
	for _, key := range []string{"accepted", "balances", "rejected"} {
		if _, ok := generic[key]; !ok {
			t.Errorf("Report JSON has no %q key: %s", key, data)
		}
	}
	empty, _ := ledger.Process(strings.NewReader(""))
	data, _ = json.Marshal(empty)
	if !strings.Contains(string(data), `"balances":[]`) || !strings.Contains(string(data), `"rejected":[]`) {
		t.Errorf("empty report must have [] lists: %s", data)
	}
}
