"""Quarterly VAT returns, one configuration per country instead of one copy per country."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Callable, Dict, List, Tuple

from ._common import (
    CENT, UNIT, ZERO, Column, Record, Records, csv_text, fmt, money, month_of, ordered, plain, refunded_tax,
    table, text, titled, year_of,
)


@dataclass(frozen=True)
class VatCountry:
    code: str
    name: str
    form: str
    currency: str
    rate: Decimal
    percent: str
    whole_units: bool = False
    notes: Tuple[str, ...] = ()

    @property
    def quantum(self) -> Decimal:
        return UNIT if self.whole_units else CENT

    @property
    def places(self) -> int:
        return 0 if self.whole_units else 2


COUNTRIES: Dict[str, VatCountry] = {c.code: c for c in (
    VatCountry("DE", "Germany", "Umsatzsteuer-Voranmeldung", "EUR", Decimal("0.19"), "19"),
    VatCountry("FR", "France", "Declaration de TVA (CA3)", "EUR", Decimal("0.20"), "20"),
    VatCountry("NL", "Netherlands", "Omzetbelastingaangifte", "EUR", Decimal("0.21"), "21"),
    VatCountry("ES", "Spain", "Modelo 303 (IVA)", "EUR", Decimal("0.21"), "21"),
    VatCountry("IT", "Italy", "Liquidazione periodica IVA", "EUR", Decimal("0.22"), "22"),
    VatCountry("GB", "United Kingdom", "VAT Return (MTD)", "GBP", Decimal("0.20"), "20"),
    VatCountry("SE", "Sweden", "Momsdeklaration", "SEK", Decimal("0.25"), "25"),
    VatCountry("JP", "Japan", "Consumption tax return", "JPY", Decimal("0.10"), "10", whole_units=True),
    VatCountry("VN", "Vietnam", "To khai thue GTGT", "VND", Decimal("0.10"), "10", whole_units=True),
    VatCountry("US", "United States", "Sales tax report", "USD", Decimal("0"), "0",
               notes=("Sales tax is not collected on US invoices.",)),
)}


@dataclass
class MonthVat:
    invoices: int = 0
    base: Decimal = ZERO
    tax: Decimal = ZERO
    refunded_tax: Decimal = ZERO

    @property
    def due(self) -> Decimal:
        return self.tax - self.refunded_tax


@dataclass
class QuarterVat:
    months: Dict[int, MonthVat]
    discounted: int = 0
    discount: Decimal = ZERO
    refunded: int = 0
    warnings: List[str] = field(default_factory=list)


def _country(code: str) -> VatCountry:
    if code not in COUNTRIES:
        raise ValueError("no VAT return for country %r" % (code,))
    return COUNTRIES[code]


def _months(quarter: int) -> List[int]:
    if quarter < 1 or quarter > 4:
        raise ValueError("quarter must be 1..4, got %r" % quarter)
    first = (quarter - 1) * 3 + 1
    return [first, first + 1, first + 2]


def _add(country: VatCountry, q: QuarterVat, r: Record) -> None:
    month = q.months[month_of(r)]
    sub, tax = money(r, "subtotal"), money(r, "tax")
    month.invoices += 1
    month.base += sub
    month.tax += tax
    month.refunded_tax += refunded_tax(r, country.quantum)
    if money(r, "discount") > ZERO:
        q.discounted += 1
        q.discount += money(r, "discount")
    if money(r, "refunded") > ZERO:
        q.refunded += 1
    expected = (sub * country.rate).quantize(country.quantum, rounding=ROUND_HALF_EVEN)
    if expected != tax:
        q.warnings.append("WARNING: %s tax %s, expected %s at %s%%" % (
            r["number"], fmt(tax, country.places), fmt(expected, country.places), country.percent))


def _quarter(records: Records, country: VatCountry, year: int, quarter: int) -> QuarterVat:
    months = _months(quarter)
    q = QuarterVat({m: MonthVat() for m in months})
    for r in ordered(records, lambda r: r["country"] == country.code and year_of(r) == year and month_of(r) in months):
        _add(country, q, r)
    return q


def _render(country: VatCountry, year: int, quarter: int, q: QuarterVat) -> str:
    columns = [Column("Month", 7, True), Column("Invoices", 8), Column("Taxable base", 16),
               Column("Tax collected", 16), Column("Tax refunded", 16), Column("Net tax due", 16)]
    f = lambda amount: fmt(amount, country.places)  # noqa: E731
    rows = [["%d-%02d" % (year, m), v.invoices, f(v.base), f(v.tax), f(v.refunded_tax), f(v.due)] for m, v in q.months.items()]
    total = MonthVat(sum(v.invoices for v in q.months.values()), sum((v.base for v in q.months.values()), ZERO),
                     sum((v.tax for v in q.months.values()), ZERO), sum((v.refunded_tax for v in q.months.values()), ZERO))
    out = titled("VAT RETURN - %s (%s) - %d Q%d" % (country.name, country.code, year, quarter))
    out += [country.form, "Currency: %s   Standard rate: %s%%" % (country.currency, country.percent), *country.notes, ""]
    out += table(columns, rows, ["TOTAL", total.invoices, f(total.base), f(total.tax), f(total.refunded_tax), f(total.due)])
    out += ["", "Discounted invoices: %d (discount %s, not deducted from the taxable base)" % (q.discounted, f(q.discount)),
            "Refunded invoices: %d" % q.refunded, ""]
    if q.warnings:
        out += ["Rate check: %d warning(s)" % len(q.warnings)] + q.warnings
    else:
        out.append("Rate check: OK")
    return text(out)


def vat_return(records: Records, country: str, year: int, quarter: int) -> str:
    spec = _country(country)
    year, quarter = int(year), int(quarter)
    return _render(spec, year, quarter, _quarter(records, spec, year, quarter))


def vat_return_csv(records: Records, country: str, year: int, quarter: int) -> str:
    spec = _country(country)
    year, quarter = int(year), int(quarter)
    q = _quarter(records, spec, year, quarter)
    rows = [[spec.code, spec.currency, "%d-%02d" % (year, m), v.invoices, plain(v.base, spec.quantum),
             plain(v.tax, spec.quantum), plain(v.refunded_tax, spec.quantum), plain(v.due, spec.quantum)]
            for m, v in q.months.items()]
    return csv_text("country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due", rows)


def _for_country(code: str) -> Tuple[Callable[..., str], Callable[..., str]]:
    def text_return(records: Records, year: int, quarter: int) -> str:
        return vat_return(records, code, year, quarter)

    def csv_return(records: Records, year: int, quarter: int) -> str:
        return vat_return_csv(records, code, year, quarter)

    text_return.__name__ = text_return.__qualname__ = "vat_return_%s" % code.lower()
    csv_return.__name__ = csv_return.__qualname__ = "vat_return_%s_csv" % code.lower()
    return text_return, csv_return


vat_return_de, vat_return_de_csv = _for_country("DE")
vat_return_fr, vat_return_fr_csv = _for_country("FR")
vat_return_nl, vat_return_nl_csv = _for_country("NL")
vat_return_es, vat_return_es_csv = _for_country("ES")
vat_return_it, vat_return_it_csv = _for_country("IT")
vat_return_gb, vat_return_gb_csv = _for_country("GB")
vat_return_se, vat_return_se_csv = _for_country("SE")
vat_return_jp, vat_return_jp_csv = _for_country("JP")
vat_return_vn, vat_return_vn_csv = _for_country("VN")
vat_return_us, vat_return_us_csv = _for_country("US")
