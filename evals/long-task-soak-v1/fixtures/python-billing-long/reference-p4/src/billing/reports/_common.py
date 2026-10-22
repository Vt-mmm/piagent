"""Shared pieces of the finance reports: record access, sums, formatting, tables."""
from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any, Callable, Dict, Hashable, Iterable, List, Mapping, Optional, Sequence

Record = Mapping[str, Any]
Records = Iterable[Record]

CENT = Decimal("0.01")
UNIT = Decimal("1")
ZERO = Decimal("0")
HUNDRED = Decimal("100")
TENTH = Decimal("0.1")
STATUS_ORDER = ("paid", "partially_refunded", "refunded", "past_due")
WHOLE_UNIT_CURRENCIES = ("JPY", "VND")


# --- records ---------------------------------------------------------------------------

def ordered(records: Records, keep: Optional[Callable[[Record], bool]] = None) -> List[Record]:
    """Records sorted by (issued_on, number), optionally filtered."""
    rows = [r for r in records if keep is None or keep(r)]
    rows.sort(key=lambda r: (r["issued_on"], r["number"]))
    return rows


def year_of(r: Record) -> int:
    return int(r["issued_on"][0:4])


def month_of(r: Record) -> int:
    return int(r["issued_on"][5:7])


def issued(r: Record) -> datetime.date:
    return datetime.date(year_of(r), month_of(r), int(r["issued_on"][8:10]))


def currency_of(r: Record) -> str:
    return r.get("currency") or "USD"


def plan_of(r: Record) -> str:
    return r.get("plan") or "(none)"


def money(r: Record, key: str) -> Decimal:
    if key == "refunded":
        return Decimal(r.get("refunded") or "0")
    return Decimal(r[key])


def net(r: Record) -> Decimal:
    return money(r, "total") - money(r, "refunded")


def in_year(year: Optional[int]) -> Callable[[Record], bool]:
    return lambda r: year is None or year_of(r) == int(year)


def in_month(year: int, month: int) -> Callable[[Record], bool]:
    return lambda r: year_of(r) == int(year) and month_of(r) == int(month)


def refunded_tax(r: Record, quantum: Decimal) -> Decimal:
    """The refund's share of the invoice tax, rounded half-even to `quantum`."""
    ref, tot = money(r, "refunded"), money(r, "total")
    if ref > ZERO and tot > ZERO:
        return (ref * money(r, "tax") / tot).quantize(quantum, rounding=ROUND_HALF_EVEN)
    return ZERO


def currency_quantum(currency: str) -> Decimal:
    return UNIT if currency in WHOLE_UNIT_CURRENCIES else CENT


# --- sums ------------------------------------------------------------------------------

@dataclass
class Sums:
    """A count and named Decimal sums."""
    count: int = 0
    amounts: Dict[str, Decimal] = field(default_factory=dict)

    def add(self, r: Record, keys: Sequence[str]) -> None:
        self.count += 1
        for key in keys:
            self.amounts[key] = self.amounts.get(key, ZERO) + money(r, key)

    def merge(self, other: "Sums") -> None:
        self.count += other.count
        for key, value in other.amounts.items():
            self.amounts[key] = self.amounts.get(key, ZERO) + value

    def __getitem__(self, key: str) -> Decimal:
        return self.amounts.get(key, ZERO)


Grouped = Dict[str, Dict[Hashable, Sums]]


def group_by_currency(rows: Iterable[Record], key: Callable[[Record], Hashable], sums: Sequence[str],
                      prefill: Sequence[Hashable] = ()) -> Grouped:
    """currency -> key -> Sums; every currency seen gets the `prefill` keys too."""
    data: Grouped = {}
    for r in rows:
        per = data.setdefault(currency_of(r), {k: Sums() for k in prefill})
        per.setdefault(key(r), Sums()).add(r, sums)
    return data


def total_of(groups: Iterable[Sums]) -> Sums:
    total = Sums()
    for sums in groups:
        total.merge(sums)
    return total


# --- formatting ------------------------------------------------------------------------

def fmt(amount: Decimal, places: int = 2) -> str:
    return ("{:,.%df}" % places).format(amount)


def plain(amount: Decimal, quantum: Decimal = CENT) -> str:
    return str(amount.quantize(quantum))


def percent_value(part: Decimal, whole: Decimal) -> Decimal:
    return (part * HUNDRED / whole).quantize(TENTH, rounding=ROUND_HALF_EVEN)


def pct(part: Decimal, whole: Decimal, sign: str = "%") -> str:
    """One decimal, half-even; "0.0" when there is nothing to divide by."""
    if whole == ZERO:
        return "0.0" + sign
    return str(percent_value(part, whole)) + sign


def average(amount: Decimal, count: int) -> Decimal:
    return (amount / Decimal(count)).quantize(CENT, rounding=ROUND_HALF_EVEN) if count > 0 else ZERO


# --- layout ----------------------------------------------------------------------------

@dataclass(frozen=True)
class Column:
    header: str
    width: int
    left: bool = False

    def cell(self, value: Any) -> str:
        text = str(value)
        return text.ljust(self.width) if self.left else text.rjust(self.width)


def line(columns: Sequence[Column], values: Sequence[Any]) -> str:
    return "  ".join(column.cell(value) for column, value in zip(columns, values))


def separator(columns: Sequence[Column]) -> str:
    return "  ".join("-" * column.width for column in columns)


def table(columns: Sequence[Column], rows: Iterable[Sequence[Any]], total: Optional[Sequence[Any]] = None) -> List[str]:
    out = [line(columns, [c.header for c in columns]), separator(columns)]
    out.extend(line(columns, row) for row in rows)
    if total is not None:
        out.extend([separator(columns), line(columns, total)])
    return out


def titled(title: str) -> List[str]:
    return [title, "=" * len(title)]


def year_title(prefix: str, year: Optional[int]) -> str:
    return f"{prefix} (ALL YEARS)" if year is None else f"{prefix} {int(year)}"


def text(lines: Iterable[str]) -> str:
    return "\n".join(lines) + "\n"


def csv_text(header: str, rows: Iterable[Sequence[Any]]) -> str:
    return text([header] + [",".join(str(v) for v in row) for row in rows])


def currency_sections(title: str, data: Mapping[str, Any], render: Callable[[str], List[str]],
                      empty: str = "No invoices.") -> str:
    """Title, then for each currency (sorted) a blank line, its name and its lines."""
    out = titled(title)
    if not data:
        return text(out + [empty])
    for cur in sorted(data):
        out += ["", f"Currency: {cur}"] + render(cur)
    return text(out)
