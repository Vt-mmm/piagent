package ledger

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type conformanceCase struct {
	Name    string          `json:"name"`
	Payload json.RawMessage `json:"payload"`
	Expect  struct {
		Error string         `json:"error"`
		OK    map[string]any `json:"ok"`
	} `json:"expect"`
}

func outcome(payload []byte) (string, map[string]any) {
	o, err := ParseOrder(payload)
	var ce *ContractError
	if errors.As(err, &ce) {
		return ce.Code, nil
	}
	q := QuoteOrder(o)
	return "", map[string]any{
		"source_version": float64(o.SourceVersion), "account_id": o.AccountID, "account_tier": o.AccountTier, "currency": o.Currency,
		"subtotal": float64(q.Subtotal), "discount": float64(q.Discount), "total": float64(q.Total),
	}
}

func TestSharedConformance(t *testing.T) {
	files, _ := filepath.Glob("../../../shared/contracts/conformance/*.json")
	if len(files) == 0 {
		t.Fatal("no conformance files")
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var cases []conformanceCase
		if err := json.Unmarshal(data, &cases); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, c := range cases {
			code, ok := outcome(c.Payload)
			if c.Expect.Error != "" {
				if code != c.Expect.Error {
					t.Errorf("%s/%s: got %q want %q", filepath.Base(file), c.Name, code, c.Expect.Error)
				}
				continue
			}
			if code != "" {
				t.Errorf("%s/%s: unexpected %s", filepath.Base(file), c.Name, code)
				continue
			}
			for k, want := range c.Expect.OK {
				if ok[k] != want {
					t.Errorf("%s/%s: %s = %v want %v", filepath.Base(file), c.Name, k, ok[k], want)
				}
			}
		}
	}
}
