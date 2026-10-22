package ledger

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

const propertySeed = 20251021

var propCurrencies = []string{"VND", "USD", "EUR", "JPY", "SGD"}

func randomPayload(rng *rand.Rand) map[string]any {
	version := 1 + rng.Intn(3)
	currency := propCurrencies[rng.Intn(len(propCurrencies))]
	name := func(key string) string { return key }
	if version == 1 {
		name = func(key string) string {
			for old, now := range legacyFields {
				if now == key {
					return old
				}
			}
			return key
		}
	}
	data := map[string]any{
		"contract_version":   version,
		"order_id":           fmt.Sprintf("O-%d", rng.Intn(1000000)),
		name("account_id"):   fmt.Sprintf("A-%d", rng.Intn(100000)),
		name("account_tier"): Tiers[rng.Intn(3)],
		"currency":           currency,
	}
	if version == 3 {
		settlement := propCurrencies[rng.Intn(len(propCurrencies))]
		data["settlement_currency"] = settlement
		data["fx_rate_ppm"] = PPM
		if settlement != currency {
			data["fx_rate_ppm"] = 1 + rng.Int63n(MaxFxRatePPM)
		}
	}
	items := []any{}
	for i := 0; i < 1+rng.Intn(4); i++ {
		items = append(items, map[string]any{"sku": fmt.Sprintf("S%d", i), "qty": 1 + rng.Intn(50), "unit_price": rng.Intn(5000001)})
	}
	data["items"] = items
	if version == 1 && rng.Intn(2) == 0 {
		delete(data, "contract_version")
	}
	return data
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPropertyValidPayloads(t *testing.T) {
	rng := rand.New(rand.NewSource(propertySeed))
	for n := 0; n < 500; n++ {
		data := randomPayload(rng)
		o, err := ParseOrder(mustJSON(t, data))
		if err != nil {
			t.Fatalf("%v: %v", data, err)
		}
		q := QuoteOrder(o)
		if q.Discount < 0 || q.Discount > q.Subtotal || q.Total != q.Subtotal-q.Discount {
			t.Fatalf("bad quote %+v", q)
		}
		want := new(big.Int).Div(new(big.Int).Mul(big.NewInt(q.Total), big.NewInt(o.FxRatePPM)), big.NewInt(PPM))
		if SettlementTotal(o) != want.Int64() {
			t.Fatalf("settlement %d want %s", SettlementTotal(o), want)
		}
		wire, err := MarshalOrder(o)
		if err != nil {
			t.Fatal(err)
		}
		again, err := ParseOrder(wire)
		if err != nil || again.AccountID != o.AccountID || again.SettlementCurrency != o.SettlementCurrency || again.FxRatePPM != o.FxRatePPM || len(again.Items) != len(o.Items) {
			t.Fatalf("round trip %s: %+v %v", wire, again, err)
		}
		if (again.SourceVersion == LatestVersion) != (o.SettlementCurrency != o.Currency) {
			t.Fatalf("writer version %d for %+v", again.SourceVersion, o)
		}
	}
}

func TestPropertyMutations(t *testing.T) {
	rng := rand.New(rand.NewSource(propertySeed + 1))
	for n := 0; n < 300; n++ {
		data := randomPayload(rng)
		version, hasVersion := data["contract_version"].(int)
		if !hasVersion {
			version = 1
		}
		code := "INVALID"
		switch choice := rng.Intn(4); {
		case choice == 0:
			data["contract_version"] = []any{0, 4, "3", 2.5, nil}[rng.Intn(5)]
			code = "UNSUPPORTED_VERSION"
		case choice == 1 && version != 3:
			data["fx_rate_ppm"] = PPM
			code = "MIXED_FIELDS"
		case choice == 2:
			data["items"].([]any)[0].(map[string]any)["qty"] = []any{0, -1, "1", 1.5, true}[rng.Intn(5)]
		default:
			data["currency"] = []string{"usd", "US1", "EURO", ""}[rng.Intn(4)]
		}
		_, err := ParseOrder(mustJSON(t, data))
		var ce *ContractError
		if !errors.As(err, &ce) || ce.Code != code {
			t.Fatalf("%v: got %v want %s", data, err, code)
		}
	}
}
