// Command ledger books an order event file and prints the balances as JSON.
//
//	ledger <events.jsonl>
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"shopflow.test/ledger-go/ledger"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: ledger <events.jsonl>")
		os.Exit(2)
	}
	file, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "ledger:", err)
		os.Exit(2)
	}
	defer file.Close()
	report, err := ledger.Process(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ledger:", err)
		os.Exit(2)
	}
	out := json.NewEncoder(os.Stdout)
	out.SetIndent("", "  ")
	if err := out.Encode(report); err != nil {
		fmt.Fprintln(os.Stderr, "ledger:", err)
		os.Exit(2)
	}
}
