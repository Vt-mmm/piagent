"""Revenue reports: by month, quarter, ISO week, country and plan."""
from __future__ import annotations

import datetime
from typing import Callable, Hashable, List, Optional, Sequence, Tuple

from ._common import (
    Column, Grouped, Records, Sums, average, csv_text, currency_sections, fmt, group_by_currency, month_of,
    ordered, plain, plan_of, table, total_of, year_of, year_title,
)

FULL = ("subtotal", "discount", "tax", "total", "refunded")
AMOUNT = Column("", 14)


def _amount_columns(*headers: str) -> List[Column]:
    return [Column(h, 14) for h in headers]


# --- periods (month, quarter, week) ----------------------------------------------------

def _iso_week(r) -> Tuple[int, int]:
    iso = datetime.date.fromisoformat(r["issued_on"][0:10]).isocalendar()
    return iso[0], iso[1]


def _by_period(records: Records, year: int, period: Callable, periods: Sequence[int],
               sums: Sequence[str], in_period_year: Callable) -> Grouped:
    rows = ordered(records, in_period_year)
    return group_by_currency(rows, period, sums, prefill=periods)


def _monthly(records: Records, year: int) -> Grouped:
    return _by_period(records, year, month_of, range(1, 13), FULL, lambda r: year_of(r) == year)


def _quarterly(records: Records, year: int) -> Grouped:
    return _by_period(records, year, lambda r: (month_of(r) - 1) // 3 + 1, range(1, 5), FULL,
                      lambda r: year_of(r) == year)


def _weeks(year: int) -> range:
    return range(1, datetime.date(year, 12, 28).isocalendar()[1] + 1)


def _weekly(records: Records, year: int) -> Grouped:
    return _by_period(records, year, lambda r: _iso_week(r)[1], _weeks(year), ("total", "refunded"),
                      lambda r: _iso_week(r)[0] == year)


def _full_text(title: str, first: Column, data: Grouped, label: Callable[[Hashable], str]) -> str:
    columns = [first, Column("Invoices", 8)] + _amount_columns("Subtotal", "Discount", "Tax", "Total", "Refunded", "Net")

    def values(name: str, s: Sums) -> list:
        return [name, s.count] + [fmt(s[k]) for k in FULL] + [fmt(s["total"] - s["refunded"])]

    def render(cur: str) -> List[str]:
        rows = [values(label(k), s) for k, s in data[cur].items()]
        return table(columns, rows, values("TOTAL", total_of(data[cur].values())))
    return currency_sections(title, data, render)


def _full_csv(header: str, data: Grouped, label: Callable[[Hashable], str]) -> str:
    rows = [[cur, label(k), s.count] + [plain(s[f]) for f in FULL] + [plain(s["total"] - s["refunded"])]
            for cur in sorted(data) for k, s in data[cur].items()]
    return csv_text(header, rows)


def revenue_by_month(records: Records, year: int) -> str:
    year = int(year)
    return _full_text(f"REVENUE BY MONTH {year}", Column("Month", 7, True), _monthly(records, year),
                      lambda m: "%d-%02d" % (year, m))


def revenue_by_month_csv(records: Records, year: int) -> str:
    year = int(year)
    return _full_csv("currency,month,invoices,subtotal,discount,tax,total,refunded,net", _monthly(records, year),
                     lambda m: "%d-%02d" % (year, m))


def revenue_by_quarter(records: Records, year: int) -> str:
    year = int(year)
    return _full_text(f"REVENUE BY QUARTER {year}", Column("Quarter", 7, True), _quarterly(records, year),
                      lambda q: "%d-Q%d" % (year, q))


def revenue_by_quarter_csv(records: Records, year: int) -> str:
    year = int(year)
    return _full_csv("currency,quarter,invoices,subtotal,discount,tax,total,refunded,net",
                     _quarterly(records, year), lambda q: "%d-Q%d" % (year, q))


def revenue_by_week(records: Records, year: int) -> str:
    year = int(year)
    data = _weekly(records, year)
    columns = [Column("Week", 8, True), Column("Invoices", 8)] + _amount_columns("Total", "Refunded", "Net")

    def values(name: str, s: Sums) -> list:
        return [name, s.count, fmt(s["total"]), fmt(s["refunded"]), fmt(s["total"] - s["refunded"])]

    def render(cur: str) -> List[str]:
        rows = [values("%d-W%02d" % (year, w), s) for w, s in data[cur].items()]
        return table(columns, rows, values("TOTAL", total_of(data[cur].values())))
    return currency_sections(f"REVENUE BY WEEK {year}", data, render)


def revenue_by_week_csv(records: Records, year: int) -> str:
    year = int(year)
    data = _weekly(records, year)
    rows = [[cur, "%d-W%02d" % (year, w), s.count, plain(s["total"]), plain(s["refunded"]),
             plain(s["total"] - s["refunded"])] for cur in sorted(data) for w, s in data[cur].items()]
    return csv_text("currency,week,invoices,total,refunded,net", rows)


# --- by country --------------------------------------------------------------------------

COUNTRY_NAMES = {
    "US": "United States", "DE": "Germany", "FR": "France", "NL": "Netherlands", "ES": "Spain",
    "IT": "Italy", "GB": "United Kingdom", "JP": "Japan", "VN": "Vietnam", "SE": "Sweden",
}
COUNTRY_SUMS = ("subtotal", "tax", "total", "refunded")


def _by_key(records: Records, year: Optional[int], key: Callable, sums: Sequence[str]) -> Grouped:
    rows = ordered(records, lambda r: year is None or year_of(r) == int(year))
    data = group_by_currency(rows, key, sums)
    return {cur: dict(sorted(per.items())) for cur, per in data.items()}


def revenue_by_country(records: Records, year: Optional[int] = None) -> str:
    data = _by_key(records, year, lambda r: r["country"], COUNTRY_SUMS)
    columns = [Column("Country", 7, True), Column("Name", 16, True), Column("Invoices", 8)] + _amount_columns(
        "Subtotal", "Tax", "Total", "Refunded", "Net")

    def values(code: str, name: str, s: Sums) -> list:
        return [code, name, s.count] + [fmt(s[k]) for k in COUNTRY_SUMS] + [fmt(s["total"] - s["refunded"])]

    def render(cur: str) -> List[str]:
        rows = [values(c, COUNTRY_NAMES.get(c, c), s) for c, s in data[cur].items()]
        return table(columns, rows, values("TOTAL", "", total_of(data[cur].values())))
    return currency_sections(year_title("REVENUE BY COUNTRY", year), data, render)


def revenue_by_country_csv(records: Records, year: Optional[int] = None) -> str:
    data = _by_key(records, year, lambda r: r["country"], COUNTRY_SUMS)
    rows = [[cur, c, s.count] + [plain(s[k]) for k in COUNTRY_SUMS] + [plain(s["total"] - s["refunded"])]
            for cur in sorted(data) for c, s in data[cur].items()]
    return csv_text("currency,country,invoices,subtotal,tax,total,refunded,net", rows)


# --- by plan -------------------------------------------------------------------------------

PLAN_SUMS = ("subtotal", "discount", "total", "refunded")


def revenue_by_plan(records: Records, year: Optional[int] = None) -> str:
    data = _by_key(records, year, plan_of, PLAN_SUMS)
    columns = [Column("Plan", 12, True), Column("Invoices", 8)] + _amount_columns(
        "Subtotal", "Discount", "Total", "Net", "Average")

    def values(name: str, s: Sums) -> list:
        return [name, s.count, fmt(s["subtotal"]), fmt(s["discount"]), fmt(s["total"]),
                fmt(s["total"] - s["refunded"]), fmt(average(s["total"], s.count))]

    def render(cur: str) -> List[str]:
        rows = [values(p, s) for p, s in data[cur].items()]
        return table(columns, rows, values("TOTAL", total_of(data[cur].values())))
    return currency_sections(year_title("REVENUE BY PLAN", year), data, render)


def revenue_by_plan_csv(records: Records, year: Optional[int] = None) -> str:
    data = _by_key(records, year, plan_of, PLAN_SUMS)
    rows = [[cur, p, s.count, plain(s["subtotal"]), plain(s["discount"]), plain(s["total"]),
             plain(s["total"] - s["refunded"]), plain(average(s["total"], s.count))]
            for cur in sorted(data) for p, s in data[cur].items()]
    return csv_text("currency,plan,invoices,subtotal,discount,total,net,average", rows)
