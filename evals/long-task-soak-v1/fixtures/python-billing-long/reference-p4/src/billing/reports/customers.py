"""Customer metrics: top customers, MRR and churn."""
from __future__ import annotations

from decimal import Decimal
from typing import Dict, List, Optional, Set, Tuple

from ._common import (
    ZERO, Column, Records, average, csv_text, currency_of, currency_sections, fmt, money, month_of, net, ordered,
    pct, percent_value, plain, table, text, titled, year_of, year_title,
)


# --- top customers -----------------------------------------------------------------------

def _ranking(records: Records, year: Optional[int], limit: int) -> Dict[str, List[Tuple[int, str, int, Decimal, Decimal]]]:
    """currency -> [(rank, customer, invoices, net revenue, currency total)] best first."""
    per: Dict[str, Dict[str, list]] = {}
    for r in ordered(records, lambda r: year is None or year_of(r) == int(year)):
        entry = per.setdefault(currency_of(r), {}).setdefault(r["customer_id"], [0, ZERO])
        entry[0] += 1
        entry[1] += net(r)
    ranked = {}
    for cur, customers in per.items():
        whole = sum((v[1] for v in customers.values()), ZERO)
        best = sorted(customers.items(), key=lambda item: (-item[1][1], item[0]))[: int(limit)]
        ranked[cur] = [(i, c, v[0], v[1], whole) for i, (c, v) in enumerate(best, start=1)]
    return ranked


def top_customers(records: Records, year: Optional[int] = None, limit: int = 10) -> str:
    data = _ranking(records, year, limit)
    columns = [Column("Rank", 4), Column("Customer", 10, True), Column("Invoices", 8), Column("Net revenue", 14),
               Column("Share", 7)]

    def render(cur: str) -> List[str]:
        return table(columns, [[rank, c, n, fmt(v), pct(v, whole)] for rank, c, n, v, whole in data[cur]])
    return currency_sections(year_title("TOP CUSTOMERS", year), data, render)


def top_customers_csv(records: Records, year: Optional[int] = None, limit: int = 10) -> str:
    data = _ranking(records, year, limit)
    rows = [[cur, rank, c, n, plain(v), pct(v, whole, sign="")] for cur in sorted(data) for rank, c, n, v, whole in data[cur]]
    return csv_text("currency,rank,customer_id,invoices,net_revenue,share_pct", rows)


# --- MRR ---------------------------------------------------------------------------------

def _mrr(records: Records, year: int) -> Dict[str, List[Tuple[int, Decimal, int, Decimal, Optional[Decimal]]]]:
    """currency -> per month: (month, MRR, customers, ARPU, growth % or None)."""
    subtotal: Dict[str, Dict[int, Decimal]] = {}
    customers: Dict[str, Dict[int, Set[str]]] = {}
    for r in ordered(records, lambda r: year_of(r) == year):
        cur = currency_of(r)
        subtotal.setdefault(cur, {m: ZERO for m in range(1, 13)})[month_of(r)] += money(r, "subtotal")
        customers.setdefault(cur, {m: set() for m in range(1, 13)})[month_of(r)].add(r["customer_id"])
    data = {}
    for cur in subtotal:
        rows, prev = [], None
        for m in range(1, 13):
            mrr, n = subtotal[cur][m], len(customers[cur][m])
            growth = None if prev is None or prev == ZERO else percent_value(mrr - prev, prev)
            rows.append((m, mrr, n, average(mrr, n), growth))
            prev = mrr
        data[cur] = rows
    return data


def mrr_report(records: Records, year: int) -> str:
    year = int(year)
    data = _mrr(records, year)
    columns = [Column("Month", 7, True), Column("MRR", 14), Column("Customers", 9), Column("ARPU", 14), Column("Growth", 8)]

    def growth(g: Optional[Decimal]) -> str:
        return "n/a" if g is None else ("+" if g > ZERO else "") + str(g) + "%"

    def render(cur: str) -> List[str]:
        return table(columns, [["%d-%02d" % (year, m), fmt(v), n, fmt(a), growth(g)] for m, v, n, a, g in data[cur]])
    return currency_sections("MRR %d" % year, data, render)


def mrr_report_csv(records: Records, year: int) -> str:
    year = int(year)
    data = _mrr(records, year)
    rows = [[cur, "%d-%02d" % (year, m), plain(v), n, plain(a), "" if g is None else str(g)]
            for cur in sorted(data) for m, v, n, a, g in data[cur]]
    return csv_text("currency,month,mrr,customers,arpu,growth_pct", rows)


# --- churn -------------------------------------------------------------------------------

def _churn(records: Records, year: int) -> Tuple[List[Tuple[int, int, int]], int]:
    """[(month, active, churned)] and the number of customers billed in the year."""
    billed: Dict[Tuple[int, int], Set[str]] = {}
    for r in ordered(records):
        billed.setdefault((year_of(r), month_of(r)), set()).add(r["customer_id"])
    rows, everyone = [], set()
    for m in range(1, 13):
        active = billed.get((year, m), set())
        following = billed.get((year + 1, 1) if m == 12 else (year, m + 1), set())
        everyone |= active
        rows.append((m, len(active), len(active - following)))
    return rows, len(everyone)


def churn_report(records: Records, year: int) -> str:
    year = int(year)
    rows, customers = _churn(records, year)
    columns = [Column("Month", 7, True), Column("Active", 8), Column("Churned", 8), Column("Churn rate", 10)]
    body = table(columns, [["%d-%02d" % (year, m), a, c, pct(Decimal(c), Decimal(a))] for m, a, c in rows])
    return text(titled("CHURN %d" % year) + body + [body[1], "Customers billed in %d: %d" % (year, customers)])


def churn_report_csv(records: Records, year: int) -> str:
    year = int(year)
    rows, _ = _churn(records, year)
    return csv_text("month,active,churned,churn_rate_pct",
                    [["%d-%02d" % (year, m), a, c, pct(Decimal(c), Decimal(a), sign="")] for m, a, c in rows])
