"""Day-to-day sales: daily totals, the invoice register and the month-end close pack."""
from __future__ import annotations

import calendar
from typing import Dict, List

from ._common import (
    ZERO, Column, Records, Sums, csv_text, currency_of, currency_sections, fmt, group_by_currency, in_month, money,
    ordered, plain, table, text, titled, total_of,
)
from .coupons import coupon_usage
from .receivables import status_summary
from .vat import COUNTRIES, vat_return


def _daily(records: Records, year: int, month: int):
    days = range(1, calendar.monthrange(year, month)[1] + 1)
    return group_by_currency(ordered(records, in_month(year, month)), lambda r: int(r["issued_on"][8:10]),
                             ("total",), prefill=days)


def daily_sales(records: Records, year: int, month: int) -> str:
    year, month = int(year), int(month)
    data = _daily(records, year, month)
    columns = [Column("Day", 10, True), Column("Invoices", 8), Column("Total", 14)]

    def render(cur: str) -> List[str]:
        rows = [["%d-%02d-%02d" % (year, month, d), s.count, fmt(s["total"])] for d, s in data[cur].items()]
        total = total_of(data[cur].values())
        return table(columns, rows, ["TOTAL", total.count, fmt(total["total"])])
    return currency_sections("DAILY SALES %d-%02d" % (year, month), data, render)


def daily_sales_csv(records: Records, year: int, month: int) -> str:
    year, month = int(year), int(month)
    data = _daily(records, year, month)
    rows = [[cur, "%d-%02d-%02d" % (year, month, d), s.count, plain(s["total"])] for cur in sorted(data) for d, s in data[cur].items()]
    return csv_text("currency,day,invoices,total", rows)


# --- invoice register --------------------------------------------------------------------

REGISTER = [Column("Date", 10, True), Column("Number", 14, True), Column("Customer", 10, True), Column("Country", 7, True),
            Column("Currency", 8, True), Column("Coupon", 12, True), Column("Subtotal", 14), Column("Tax", 14),
            Column("Total", 14), Column("Status", 18, True)]


def invoice_register(records: Records, year: int, month: int) -> str:
    year, month = int(year), int(month)
    rows = ordered(records, in_month(year, month))
    out = titled("INVOICE REGISTER %d-%02d" % (year, month))
    if not rows:
        return text(out + ["No invoices."])
    body = table(REGISTER, [[r["issued_on"], r["number"], r["customer_id"], r["country"], currency_of(r),
                             r.get("coupon_code") or "", fmt(money(r, "subtotal")), fmt(money(r, "tax")),
                             fmt(money(r, "total")), r["status"]] for r in rows])
    per: Dict[str, Sums] = {}
    for r in rows:
        per.setdefault(currency_of(r), Sums()).add(r, ("total",))
    summary = ["%s: %d invoice(s), total %s" % (cur, s.count, fmt(s["total"])) for cur, s in sorted(per.items())]
    return text(out + body + [body[1]] + summary)


def invoice_register_csv(records: Records, year: int, month: int) -> str:
    amounts = ("subtotal", "discount", "tax", "total", "refunded")
    rows = [[r["issued_on"], r["number"], r["customer_id"], r["country"], currency_of(r), r.get("coupon_code") or ""]
            + [plain(money(r, k)) for k in amounts] + [r["status"]]
            for r in ordered(records, in_month(int(year), int(month)))]
    return csv_text("issued_on,number,customer_id,country,currency,coupon_code,subtotal,discount,tax,total,refunded,status", rows)


# --- month-end close pack ----------------------------------------------------------------

def monthly_close_pack(records: Records, year: int, month: int) -> str:
    year, month = int(year), int(month)
    pages = [invoice_register(records, year, month), daily_sales(records, year, month),
             status_summary(records, year), coupon_usage(records, year)]
    if month % 3 == 0:
        pages += [vat_return(records, code, year, month // 3) for code in COUNTRIES]
    head = "MONTH-END CLOSE PACK %d-%02d" % (year, month)
    out = head + "\n" + "#" * len(head) + "\n"
    for number, page in enumerate(pages, start=1):
        out += "\n" + "-" * 30 + " page %d " % number + "-" * 30 + "\n" + page
    return out
