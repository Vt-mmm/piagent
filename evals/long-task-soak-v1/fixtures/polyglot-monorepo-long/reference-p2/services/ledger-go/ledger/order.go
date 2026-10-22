// Package ledger reads order events (shared/contracts/order.schema.json) and
// books them into per-account balances. Standard library only.
package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
)

// ContractVersion is the order contract version the writer produces.
const ContractVersion = 2

// Tiers are the account tiers, in schema order.
var Tiers = []string{"standard", "gold", "vip"}

var discountPercent = map[string]int64{"standard": 0, "gold": 5, "vip": 10}

var currencyRE = regexp.MustCompile(`^[A-Z]{3}$`)

// ContractError is a payload that does not follow the order contract.
// Code is INVALID, MIXED_FIELDS or UNSUPPORTED_VERSION.
type ContractError struct {
	Code    string
	Message string
}

func (e *ContractError) Error() string { return e.Code + ": " + e.Message }

func contractErr(code, format string, args ...any) error {
	return &ContractError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Item is one order line; amounts are integers in the currency's smallest unit.
type Item struct {
	SKU       string
	Qty       int64
	UnitPrice int64
}

// Order is a parsed order payload (v2, or legacy v1 upgraded through the compat shim).
type Order struct {
	OrderID       string
	AccountID     string
	AccountTier   string
	Currency      string
	Items         []Item
	SourceVersion int
}

// ParseOrder validates one JSON order payload.
func ParseOrder(data []byte) (Order, error) {
	value, err := decodeJSON(data)
	if err != nil {
		return Order{}, contractErr("INVALID", "order is not valid JSON: %v", err)
	}
	return parseValue(value)
}

func decodeJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing data after the JSON value")
	}
	return value, nil
}

// intValue is a JSON integer (not a bool, not a fraction).
func intValue(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := strconv.ParseInt(string(n), 10, 64)
	return i, err == nil
}

func text(obj map[string]any, key string) (string, error) {
	s, ok := obj[key].(string)
	if !ok || s == "" {
		return "", contractErr("INVALID", "%s must be a non-empty string", key)
	}
	return s, nil
}

func hasAny(obj map[string]any, keys []string) bool {
	for _, k := range keys {
		if _, ok := obj[k]; ok {
			return true
		}
	}
	return false
}

func parseValue(value any) (Order, error) {
	obj, ok := value.(map[string]any)
	if !ok {
		return Order{}, contractErr("INVALID", "order must be an object")
	}
	source := ContractVersion
	if isV1(obj) {
		if hasAny(obj, newFields) {
			return Order{}, contractErr("MIXED_FIELDS", "a v1 payload cannot carry v2 fields")
		}
		obj, source = upgradeV1(obj), 1
	} else {
		if v, ok := intValue(obj["contract_version"]); !ok || v != ContractVersion {
			return Order{}, contractErr("UNSUPPORTED_VERSION", "unsupported contract_version: %v", obj["contract_version"])
		}
		if hasAny(obj, legacyFieldNames()) {
			return Order{}, contractErr("MIXED_FIELDS", "a v2 payload cannot carry v1 fields")
		}
	}
	tier, _ := obj["account_tier"].(string)
	if _, ok := discountPercent[tier]; !ok {
		return Order{}, contractErr("INVALID", "account_tier must be one of standard, gold, vip")
	}
	currency, err := text(obj, "currency")
	if err != nil {
		return Order{}, err
	}
	if !currencyRE.MatchString(currency) {
		return Order{}, contractErr("INVALID", "currency must be a 3-letter code")
	}
	orderID, err := text(obj, "order_id")
	if err != nil {
		return Order{}, err
	}
	accountID, err := text(obj, "account_id")
	if err != nil {
		return Order{}, err
	}
	items, err := parseItems(obj["items"])
	if err != nil {
		return Order{}, err
	}
	return Order{OrderID: orderID, AccountID: accountID, AccountTier: tier, Currency: currency, Items: items, SourceVersion: source}, nil
}

func parseItems(raw any) ([]Item, error) {
	rows, ok := raw.([]any)
	if !ok || len(rows) == 0 {
		return nil, contractErr("INVALID", "items must be a non-empty list")
	}
	items := make([]Item, 0, len(rows))
	for i, r := range rows {
		row, ok := r.(map[string]any)
		if !ok {
			return nil, contractErr("INVALID", "items[%d] must be an object", i)
		}
		sku, err := text(row, "sku")
		if err != nil {
			return nil, err
		}
		qty, ok := intValue(row["qty"])
		if !ok || qty < 1 {
			return nil, contractErr("INVALID", "items[%d].qty must be a positive integer", i)
		}
		price, ok := intValue(row["unit_price"])
		if !ok || price < 0 {
			return nil, contractErr("INVALID", "items[%d].unit_price must be a non-negative integer", i)
		}
		items = append(items, Item{SKU: sku, Qty: qty, UnitPrice: price})
	}
	return items, nil
}
