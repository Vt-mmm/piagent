"""Coupon reports: redemptions and discount leakage per plan."""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from ._common import (
    ZERO, Column, Grouped, Records, Sums, average, csv_text, currency_of, currency_sections, fmt, group_by_currency,
    money, ordered, pct, plain, plan_of, table, text, titled, total_of, year_of, year_title,
)


def _usage(records: Records, year: Optional[int]) -> Dict[Tuple[str, str], Sums]:
    data: Dict[Tuple[str, str], Sums] = {}
    for r in ordered(records, lambda r: (year is None or year_of(r) == int(year)) and r.get("coupon_code")):
        data.setdefault((r["coupon_code"], currency_of(r)), Sums()).add(r, ("discount",))
    return dict(sorted(data.items()))


def coupon_usage(records: Records, year: Optional[int] = None) -> str:
    data = _usage(records, year)
    out = titled(year_title("COUPON USAGE", year))
    if not data:
        return text(out + ["No coupons redeemed."])
    columns = [Column("Coupon", 12, True), Column("Currency", 8, True), Column("Uses", 6), Column("Discount", 14),
               Column("Average", 14)]
    rows = [[code, cur, s.count, fmt(s["discount"]), fmt(average(s["discount"], s.count))] for (code, cur), s in data.items()]
    return text(out + table(columns, rows))


def coupon_usage_csv(records: Records, year: Optional[int] = None) -> str:
    rows = [[code, cur, s.count, plain(s["discount"]), plain(average(s["discount"], s.count))]
            for (code, cur), s in _usage(records, year).items()]
    return csv_text("coupon_code,currency,uses,discount,average", rows)


# --- discount leakage -----------------------------------------------------------------------

def _leakage(records: Records, year: Optional[int]) -> Grouped:
    rows = ordered(records, lambda r: year is None or year_of(r) == int(year))
    data = group_by_currency(rows, plan_of, ("subtotal", "discount"))
    for r in rows:
        if money(r, "discount") > ZERO:
            sums = data[currency_of(r)][plan_of(r)]
            sums.amounts["discounted"] = sums["discounted"] + 1
    return {cur: dict(sorted(per.items())) for cur, per in data.items()}


def discount_leakage(records: Records, year: Optional[int] = None) -> str:
    data = _leakage(records, year)
    columns = [Column("Plan", 12, True), Column("Invoices", 8), Column("Discounted", 10), Column("Subtotal", 14),
               Column("Discount", 14), Column("Leakage", 8)]

    def values(name: str, s: Sums) -> list:
        return [name, s.count, int(s["discounted"]), fmt(s["subtotal"]), fmt(s["discount"]), pct(s["discount"], s["subtotal"])]

    def render(cur: str) -> List[str]:
        return table(columns, [values(p, s) for p, s in data[cur].items()], values("TOTAL", total_of(data[cur].values())))
    return currency_sections(year_title("DISCOUNT LEAKAGE", year), data, render)


def discount_leakage_csv(records: Records, year: Optional[int] = None) -> str:
    data = _leakage(records, year)
    rows = [[cur, p, s.count, int(s["discounted"]), plain(s["subtotal"]), plain(s["discount"]),
             pct(s["discount"], s["subtotal"], sign="")] for cur in sorted(data) for p, s in data[cur].items()]
    return csv_text("currency,plan,invoices,discounted,subtotal,discount,leakage_pct", rows)
