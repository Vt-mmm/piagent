"""What customers owe: aging of overdue invoices, statements, invoice status."""
from __future__ import annotations

import datetime
from typing import Dict, List, Optional

from ._common import (
    STATUS_ORDER, ZERO, Column, Records, Sums, csv_text, currency_of, currency_sections, fmt, issued, money, net,
    ordered, plain, table, text, titled, total_of, year_of, year_title,
)

BUCKETS = ("0-30", "31-60", "61-90", "90+")


def _bucket(days: int) -> str:
    if days <= 30:
        return BUCKETS[0]
    if days <= 60:
        return BUCKETS[1]
    return BUCKETS[2] if days <= 90 else BUCKETS[3]


def _aging(records: Records, as_of: datetime.date) -> Dict[str, Dict[str, Dict[str, object]]]:
    """currency -> customer -> bucket -> outstanding amount."""
    data: Dict[str, Dict[str, Dict[str, object]]] = {}
    for r in ordered(records, lambda r: r["status"] == "past_due"):
        days = (as_of - issued(r)).days
        if days < 0:
            continue
        buckets = data.setdefault(currency_of(r), {}).setdefault(r["customer_id"], {b: ZERO for b in BUCKETS})
        buckets[_bucket(days)] += net(r)
    return data


def aging_report(records: Records, as_of: datetime.date) -> str:
    data = _aging(records, as_of)
    columns = [Column("Customer", 10, True)] + [Column(b, 14) for b in BUCKETS] + [Column("Total", 14)]

    def values(name: str, buckets: dict) -> list:
        return [name] + [fmt(buckets[b]) for b in BUCKETS] + [fmt(sum((buckets[b] for b in BUCKETS), ZERO))]

    def render(cur: str) -> List[str]:
        customers = data[cur]
        rows = [values(c, customers[c]) for c in sorted(customers)]
        totals = {b: sum((customers[c][b] for c in customers), ZERO) for b in BUCKETS}
        return table(columns, rows, values("TOTAL", totals))
    return currency_sections("AGING REPORT AS OF %s" % as_of.isoformat(), data, render, empty="No overdue invoices.")


def aging_report_csv(records: Records, as_of: datetime.date) -> str:
    data = _aging(records, as_of)
    rows = [[cur, c] + [plain(data[cur][c][b]) for b in BUCKETS] + [plain(sum((data[cur][c][b] for b in BUCKETS), ZERO))]
            for cur in sorted(data) for c in sorted(data[cur])]
    return csv_text("currency,customer_id,bucket_0_30,bucket_31_60,bucket_61_90,bucket_90_plus,total", rows)


# --- statements --------------------------------------------------------------------------

def _statement_lines(records: Records, customer_id: str) -> Dict[str, List[list]]:
    """currency -> [date, number, status, charged, refunded, running balance due]."""
    lines: Dict[str, List[list]] = {}
    balances: Dict[str, object] = {}
    for r in ordered(records, lambda r: r["customer_id"] == customer_id):
        cur = currency_of(r)
        if r["status"] == "past_due":
            balances[cur] = balances.get(cur, ZERO) + net(r)
        lines.setdefault(cur, []).append([r["issued_on"], r["number"], r["status"], money(r, "total"),
                                          money(r, "refunded"), balances.get(cur, ZERO)])
    return dict(sorted(lines.items()))


def customer_statement(records: Records, customer_id: str) -> str:
    data = _statement_lines(records, customer_id)
    columns = [Column("Date", 10, True), Column("Number", 14, True), Column("Status", 18, True),
               Column("Charged", 14), Column("Refunded", 14), Column("Balance", 14)]
    if not data:
        return text(titled("STATEMENT FOR %s" % customer_id) + ["No invoices for this customer."])

    def render(cur: str) -> List[str]:
        rows = data[cur]
        out = table(columns, [row[:3] + [fmt(v) for v in row[3:]] for row in rows])
        charged = sum((row[3] for row in rows), ZERO)
        refunded = sum((row[4] for row in rows), ZERO)
        return out + [out[1], "Total charged: %s   Total refunded: %s   Balance due: %s" % (
            fmt(charged), fmt(refunded), fmt(rows[-1][5]))]
    return currency_sections("STATEMENT FOR %s" % customer_id, data, render)


def customer_statement_csv(records: Records, customer_id: str) -> str:
    data = _statement_lines(records, customer_id)
    rows = [[cur] + row[:3] + [plain(v) for v in row[3:]] for cur in data for row in data[cur]]
    return csv_text("currency,date,number,status,charged,refunded,balance", rows)


# --- status summary ----------------------------------------------------------------------

def _status_summary(records: Records, year: Optional[int]) -> Dict[str, Dict[str, Sums]]:
    data: Dict[str, Dict[str, Sums]] = {}
    for r in ordered(records, lambda r: year is None or year_of(r) == int(year)):
        sums = data.setdefault(currency_of(r), {}).setdefault(r["status"], Sums())
        sums.add(r, ("total", "refunded"))
        sums.amounts["outstanding"] = sums["outstanding"] + (net(r) if r["status"] == "past_due" else ZERO)
    order = lambda statuses: [s for s in STATUS_ORDER if s in statuses] + sorted(s for s in statuses if s not in STATUS_ORDER)  # noqa: E731
    return {cur: {s: per[s] for s in order(per)} for cur, per in data.items()}


def status_summary(records: Records, year: Optional[int] = None) -> str:
    data = _status_summary(records, year)
    columns = [Column("Status", 18, True), Column("Invoices", 8), Column("Total", 14), Column("Refunded", 14),
               Column("Outstanding", 14)]

    def values(name: str, s: Sums) -> list:
        return [name, s.count, fmt(s["total"]), fmt(s["refunded"]), fmt(s["outstanding"])]

    def render(cur: str) -> List[str]:
        return table(columns, [values(st, s) for st, s in data[cur].items()], values("TOTAL", total_of(data[cur].values())))
    return currency_sections(year_title("STATUS SUMMARY", year), data, render)


def status_summary_csv(records: Records, year: Optional[int] = None) -> str:
    data = _status_summary(records, year)
    rows = [[cur, st, s.count, plain(s["total"]), plain(s["refunded"]), plain(s["outstanding"])]
            for cur in sorted(data) for st, s in data[cur].items()]
    return csv_text("currency,status,invoices,total,refunded,outstanding", rows)
