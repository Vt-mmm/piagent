package ledger

import (
	"bufio"
	"io"
	"sort"
	"strings"
)

// Event types.
const (
	OrderPlaced   = "order.placed"
	OrderRefunded = "order.refunded"
)

// Balance is what one account owes in one settlement currency (placed minus
// refunded settlement totals).
type Balance struct {
	AccountID string `json:"account_id"`
	Currency  string `json:"currency"`
	Balance   int64  `json:"balance"`
}

// Rejection is an event line that was not booked.
type Rejection struct {
	Line    int    `json:"line"`
	EventID string `json:"event_id"`
	Code    string `json:"code"`
}

// Report is the result of booking an event file.
type Report struct {
	Accepted int         `json:"accepted"`
	Balances []Balance   `json:"balances"`
	Rejected []Rejection `json:"rejected"`
}

type balanceKey struct{ account, currency string }

// Process books every event line of r (JSON Lines). Blank lines are skipped;
// lines that cannot be booked are reported in Rejected. The error is only for
// reading r.
func Process(r io.Reader) (Report, error) {
	report := Report{Balances: []Balance{}, Rejected: []Rejection{}}
	totals := map[balanceKey]int64{}
	seen := map[string]bool{}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		text := scanner.Text()
		if strings.TrimSpace(text) == "" {
			continue
		}
		key, amount, eventID, code := book(text, seen)
		if code != "" {
			report.Rejected = append(report.Rejected, Rejection{Line: line, EventID: eventID, Code: code})
			continue
		}
		seen[eventID] = true
		totals[key] += amount
		report.Accepted++
	}
	if err := scanner.Err(); err != nil {
		return report, err
	}
	for k, v := range totals {
		report.Balances = append(report.Balances, Balance{AccountID: k.account, Currency: k.currency, Balance: v})
	}
	sort.Slice(report.Balances, func(i, j int) bool {
		a, b := report.Balances[i], report.Balances[j]
		if a.AccountID != b.AccountID {
			return a.AccountID < b.AccountID
		}
		return a.Currency < b.Currency
	})
	return report, nil
}

// book checks one event line: BAD_JSON, BAD_EVENT, UNKNOWN_TYPE, DUPLICATE,
// then the order contract codes.
func book(text string, seen map[string]bool) (balanceKey, int64, string, string) {
	value, err := decodeJSON([]byte(text))
	if err != nil {
		return balanceKey{}, 0, "", "BAD_JSON"
	}
	event, ok := value.(map[string]any)
	if !ok {
		return balanceKey{}, 0, "", "BAD_JSON"
	}
	eventID, _ := event["event_id"].(string)
	orderValue, hasOrder := event["order"]
	if eventID == "" || !hasOrder {
		return balanceKey{}, 0, eventID, "BAD_EVENT"
	}
	kind, _ := event["type"].(string)
	if kind != OrderPlaced && kind != OrderRefunded {
		return balanceKey{}, 0, eventID, "UNKNOWN_TYPE"
	}
	if seen[eventID] {
		return balanceKey{}, 0, eventID, "DUPLICATE"
	}
	order, err := parseValue(orderValue)
	if err != nil {
		return balanceKey{}, 0, eventID, err.(*ContractError).Code
	}
	amount := SettlementTotal(order)
	if kind == OrderRefunded {
		amount = -amount
	}
	return balanceKey{order.AccountID, order.SettlementCurrency}, amount, eventID, ""
}
