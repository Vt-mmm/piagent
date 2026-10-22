// Hidden evaluator (soak oracle): ledger-go on .soak/p3/cases.jsonl → JSON lines on stdout.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"shopflow.test/ledger-go/ledger"
)

func main() {
	file, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	out := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		order, err := ledger.ParseOrder(scanner.Bytes())
		var ce *ledger.ContractError
		if errors.As(err, &ce) {
			_ = out.Encode(map[string]any{"error": ce.Code})
			continue
		}
		if err != nil {
			_ = out.Encode(map[string]any{"crash": err.Error()})
			continue
		}
		q := ledger.QuoteOrder(order)
		wire, err := ledger.MarshalOrder(order)
		if err != nil {
			_ = out.Encode(map[string]any{"crash": err.Error()})
			continue
		}
		_ = out.Encode(map[string]any{"ok": map[string]any{
			"source_version": order.SourceVersion, "account_id": order.AccountID, "account_tier": order.AccountTier,
			"currency": order.Currency, "settlement_currency": order.SettlementCurrency, "fx_rate_ppm": order.FxRatePPM,
			"subtotal": q.Subtotal, "discount": q.Discount, "total": q.Total, "settlement_total": ledger.SettlementTotal(order),
			"wire": json.RawMessage(wire),
		}})
	}
}
