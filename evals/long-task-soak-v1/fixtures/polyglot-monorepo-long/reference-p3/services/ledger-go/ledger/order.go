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

// ContractVersion is the version the writer produces when nothing converts;
// LatestVersion (v3) adds settlement_currency and fx_rate_ppm.
const (
	ContractVersion = 2
	LatestVersion   = 3
	PPM             = 1_000_000
	MaxFxRatePPM    = 1_000_000_000
)

var settlementFields = []string{"settlement_currency", "fx_rate_ppm"}

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

// Order is a parsed order payload (v3, v2, or legacy v1 upgraded through the
// compat shim). For v1/v2 the settlement currency is Currency at PPM.
type Order struct {
	OrderID            string
	AccountID          string
	AccountTier        string
	Currency           string
	Items              []Item
	SourceVersion      int
	SettlementCurrency string
	FxRatePPM          int64
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
	var source int
	if isV1(obj) {
		if hasAny(obj, newFields) || hasAny(obj, settlementFields) {
			return Order{}, contractErr("MIXED_FIELDS", "a v1 payload cannot carry v2/v3 fields")
		}
		obj, source = upgradeV1(obj), 1
	} else {
		v, ok := intValue(obj["contract_version"])
		if !ok || (v != ContractVersion && v != LatestVersion) {
			return Order{}, contractErr("UNSUPPORTED_VERSION", "unsupported contract_version: %v", obj["contract_version"])
		}
		source = int(v)
		if hasAny(obj, legacyFieldNames()) {
			return Order{}, contractErr("MIXED_FIELDS", "a v%d payload cannot carry v1 fields", source)
		}
		if source == ContractVersion && hasAny(obj, settlementFields) {
			return Order{}, contractErr("MIXED_FIELDS", "a v2 payload cannot carry v3 fields")
		}
	}
	tier, _ := obj["account_tier"].(string)
	if _, ok := discountPercent[tier]; !ok {
		return Order{}, contractErr("INVALID", "account_tier must be one of standard, gold, vip")
	}
	currency, err := currencyCode(obj, "currency")
	if err != nil {
		return Order{}, err
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
	order := Order{OrderID: orderID, AccountID: accountID, AccountTier: tier, Currency: currency, Items: items,
		SourceVersion: source, SettlementCurrency: currency, FxRatePPM: PPM}
	if source == LatestVersion {
		if order.SettlementCurrency, err = currencyCode(obj, "settlement_currency"); err != nil {
			return Order{}, err
		}
		rate, ok := intValue(obj["fx_rate_ppm"])
		if !ok || rate < 1 || rate > MaxFxRatePPM {
			return Order{}, contractErr("INVALID", "fx_rate_ppm must be an integer from 1 to %d", MaxFxRatePPM)
		}
		if order.SettlementCurrency == currency && rate != PPM {
			return Order{}, contractErr("INVALID", "fx_rate_ppm must be %d when settlement_currency equals currency", PPM)
		}
		order.FxRatePPM = rate
	}
	return order, nil
}

func currencyCode(obj map[string]any, key string) (string, error) {
	value, err := text(obj, key)
	if err != nil {
		return "", err
	}
	if !currencyRE.MatchString(value) {
		return "", contractErr("INVALID", "%s must be a 3-letter code", key)
	}
	return value, nil
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
