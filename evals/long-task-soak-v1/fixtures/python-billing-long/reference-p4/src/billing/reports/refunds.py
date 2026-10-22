"""Refund report: refunds per month and the fully refunded invoices."""
from __future__ import annotations

from typing import List, Tuple

from ._common import (
    ZERO, Column, Grouped, Records, Sums, csv_text, currency_sections, fmt, group_by_currency, money, month_of,
    ordered, pct, plain, table, total_of, year_of,
)

LISTED = 20


def _refunds(records: Records, year: int) -> Tuple[Grouped, List[str]]:
    rows = ordered(records, lambda r: year_of(r) == year)
    data = group_by_currency(rows, month_of, ("refunded", "total"), prefill=range(1, 13))
    for r in rows:
        if money(r, "refunded") > ZERO:
            sums = data[r.get("currency") or "USD"][month_of(r)]
            sums.amounts["refunds"] = sums["refunds"] + 1
    return data, [r["number"] for r in rows if r["status"] == "refunded"]


def refund_report(records: Records, year: int) -> str:
    year = int(year)
    data, full = _refunds(records, year)
    columns = [Column("Month", 7, True), Column("Invoices", 8), Column("Refunded", 8), Column("Amount", 14),
               Column("Refund rate", 11)]

    def values(name: str, s: Sums) -> list:
        return [name, s.count, int(s["refunds"]), fmt(s["refunded"]), pct(s["refunded"], s["total"])]

    def render(cur: str) -> List[str]:
        rows = [values("%d-%02d" % (year, m), s) for m, s in data[cur].items()]
        return table(columns, rows, values("TOTAL", total_of(data[cur].values())))
    report = currency_sections("REFUNDS %d" % year, data, render)
    if not data:
        return report
    listed = ["", "Fully refunded invoices (%d):" % len(full)] + ["  " + n for n in full[:LISTED]]
    if len(full) > LISTED:
        listed.append("  ... and %d more" % (len(full) - LISTED))
    return report + "\n".join(listed) + "\n"


def refund_report_csv(records: Records, year: int) -> str:
    year = int(year)
    data, _ = _refunds(records, year)
    rows = [[cur, "%d-%02d" % (year, m), s.count, int(s["refunds"]), plain(s["refunded"]), pct(s["refunded"], s["total"], sign="")]
            for cur in sorted(data) for m, s in data[cur].items()]
    return csv_text("currency,month,invoices,refunded_invoices,refunded_amount,refund_rate_pct", rows)
