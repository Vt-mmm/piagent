package ledger

// Quote is the same quote pricing-py and web-js compute: integer amounts,
// the tier discount rounded down.
type Quote struct {
	OrderID   string
	AccountID string
	Currency  string
	Subtotal  int64
	Discount  int64
	Total     int64
}

// QuoteOrder prices an order.
func QuoteOrder(o Order) Quote {
	var subtotal int64
	for _, it := range o.Items {
		subtotal += it.Qty * it.UnitPrice
	}
	discount := subtotal * discountPercent[o.AccountTier] / 100
	return Quote{OrderID: o.OrderID, AccountID: o.AccountID, Currency: o.Currency, Subtotal: subtotal, Discount: discount, Total: subtotal - discount}
}

// SettlementTotal is the quote total in the settlement currency:
// total * FxRatePPM / 1 000 000, rounded down.
func SettlementTotal(o Order) int64 {
	rate := o.FxRatePPM
	if rate == 0 {
		rate = PPM
	}
	return QuoteOrder(o).Total * rate / PPM
}
