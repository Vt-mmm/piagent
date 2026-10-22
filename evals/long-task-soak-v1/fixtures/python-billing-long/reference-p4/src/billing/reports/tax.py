"""Tax summary across all countries."""
from __future__ import annotations

from typing import Dict, Tuple

from ._common import (
    Records, Sums, Column, csv_text, currency_of, currency_quantum, fmt, ordered, plain, refunded_tax, table, text,
    titled, year_of,
)


def _tax(records: Records, year: int) -> Dict[Tuple[str, str], Sums]:
    data: Dict[Tuple[str, str], Sums] = {}
    for r in ordered(records, lambda r: year_of(r) == year):
        cur = currency_of(r)
        sums = data.setdefault((r["country"], cur), Sums())
        sums.add(r, ("subtotal", "tax"))
        sums.amounts["refunded_tax"] = sums["refunded_tax"] + refunded_tax(r, currency_quantum(cur))
    return dict(sorted(data.items()))


def tax_summary(records: Records, year: int) -> str:
    year = int(year)
    data = _tax(records, year)
    out = titled("TAX SUMMARY %d" % year)
    if not data:
        return text(out + ["No invoices."])
    columns = [Column("Country", 7, True), Column("Currency", 8, True), Column("Invoices", 8), Column("Taxable", 16),
               Column("Tax", 16), Column("Tax refunded", 16), Column("Net tax", 16)]
    rows = [[country, cur, s.count, fmt(s["subtotal"]), fmt(s["tax"]), fmt(s["refunded_tax"]), fmt(s["tax"] - s["refunded_tax"])]
            for (country, cur), s in data.items()]
    return text(out + table(columns, rows))


def tax_summary_csv(records: Records, year: int) -> str:
    rows = [[country, cur, s.count, plain(s["subtotal"]), plain(s["tax"]), plain(s["refunded_tax"]),
             plain(s["tax"] - s["refunded_tax"])] for (country, cur), s in _tax(records, int(year)).items()]
    return csv_text("country,currency,invoices,taxable,tax,tax_refunded,net_tax", rows)
