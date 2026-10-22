# Hidden acceptance checks for docs/MULTICURRENCY.md plus the product owner's decision:
#   refund FX -> a refund is converted at the rate of the ORIGINAL INVOICE date (the invoice's fx_rate)
# The soak oracle lays this file over the agent's work; the agent never sees it.
import json
import re
from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest

from billing import BillingError, BillingService, Coupon, Plan, export_csv, export_json, format_money, load_fx_rates, round_money

PLANS = [Plan("basic", "Basic", D("10.00")), Plan("pro", "Pro", D("30.00"))]
FX = """date,currency,per_usd
2026-01-02,EUR,0.9000
2026-01-05,EUR,0.9500
2026-02-02,EUR,0.8000
2026-01-02,JPY,150.00
2026-02-02,JPY,160.00
2026-01-02,GBP,0.8000
"""
PROJECT = Path(__file__).resolve().parents[1]


def code(excinfo):
    return excinfo.value.code


@pytest.fixture
def fx(tmp_path):
    path = tmp_path / "fx.csv"
    path.write_text(FX)
    return load_fx_rates(str(path))


@pytest.fixture
def s(fx):
    s = BillingService(PLANS, fx=fx)
    s.add_coupon(Coupon("FIVE", "fixed", D("5")))
    s.add_coupon(Coupon("P15", "percent", D("15")))
    return s


# --- decision: refunds use the original invoice's rate --------------------------------

def test_refund_is_converted_at_the_invoice_rate(s):
    inv = s.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")
    assert inv.fx_rate == D("150.00")
    note = s.refund(inv.number, D("1500"), on=date(2026, 2, 5))  # rate that day: 160
    assert note.currency == "JPY"
    assert note.amount_usd == D("10.00")  # 1500 / 150, not 1500 / 160 = 9.38


def test_full_refund_in_euro_uses_invoice_rate(s):
    inv = s.subscribe("c1", "basic", "DE", date(2026, 1, 5), currency="EUR")  # rate 0.95
    note = s.refund(inv.number, on=date(2026, 2, 3))  # rate that day: 0.80
    assert note.amount == D("11.30")
    assert note.amount_usd == D("11.89")  # 11.30 / 0.95 = 11.894..; at 0.80 it would be 14.13
    assert note.amount_usd == inv.total_usd


def test_revenue_usd_nets_refunds_at_invoice_rate(s):
    a = s.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")      # 4950 JPY = 33.00 USD
    b = s.subscribe("c2", "basic", "US", date(2026, 1, 12))                    # 10.00 USD
    s.refund(a.number, D("1500"), on=date(2026, 2, 5))                          # -10.00 USD
    assert s.revenue_usd(date(2026, 1, 1), date(2026, 2, 1)) == D("43.00")
    assert s.revenue_usd(date(2026, 2, 1), date(2026, 3, 1)) == D("-10.00")
    assert s.revenue_usd(date(2026, 1, 1), date(2026, 3, 1)) == D("33.00")
    assert b.total_usd == D("10.00")


# --- currencies and rounding ----------------------------------------------------------

def test_round_and_format_by_currency():
    assert round_money(D("2.5"), "JPY") == D("2")
    assert round_money(D("3.5"), "JPY") == D("4")
    assert round_money(D("1234.5"), "VND") == D("1234")
    assert round_money(D("2.345"), "EUR") == D("2.34")
    assert round_money(D("2.345")) == D("2.34")
    assert format_money(D("1510"), "JPY") == "1510"
    assert format_money(D("12.3"), "EUR") == "12.30"
    assert format_money(D("3")) == "3.00"
    with pytest.raises(BillingError) as e:
        round_money(D("1"), "XYZ")
    assert code(e) == "UNKNOWN_CURRENCY"


# --- the FX table -----------------------------------------------------------------------

def test_rates_use_latest_business_day(fx):
    assert fx.rate("USD", date(2020, 1, 1)) == D("1")
    assert fx.rate("EUR", date(2026, 1, 2)) == D("0.9000")
    assert fx.rate("EUR", date(2026, 1, 4)) == D("0.9000")   # Sunday
    assert fx.rate("EUR", date(2026, 1, 5)) == D("0.9500")
    assert fx.rate("EUR", date(2026, 3, 1)) == D("0.8000")
    assert fx.currencies() == {"USD", "EUR", "JPY", "GBP"}
    with pytest.raises(BillingError) as e:
        fx.rate("EUR", date(2026, 1, 1))
    assert code(e) == "FX_RATE_MISSING"
    with pytest.raises(BillingError) as e:
        fx.rate("CHF", date(2026, 1, 9))
    assert code(e) == "UNKNOWN_CURRENCY"


def test_rows_in_any_order_and_blank_lines(tmp_path):
    lines = FX.strip().splitlines()
    path = tmp_path / "shuffled.csv"
    path.write_text("\n".join([lines[0]] + list(reversed(lines[1:])) + ["", ""]) + "\n")
    table = load_fx_rates(str(path))
    assert table.rate("EUR", date(2026, 1, 20)) == D("0.9500")


@pytest.mark.parametrize("bad_row", ["2026-01-03,EUR", "2026-13-01,EUR,0.9", "2026-01-03,EUR,abc", "2026-01-03,EUR,-0.5", "2026-01-03,EUR,0"])
def test_bad_fx_file_names_the_line(tmp_path, bad_row):
    path = tmp_path / "bad.csv"
    path.write_text("date,currency,per_usd\n2026-01-02,EUR,0.9\n" + bad_row + "\n")
    with pytest.raises(BillingError) as e:
        load_fx_rates(str(path))
    assert code(e) == "BAD_FX_FILE"
    assert re.search(r"\b3\b", str(e.value))


def test_real_table():
    table = load_fx_rates(str(PROJECT / "data" / "fx_rates.csv"))
    assert table.rate("EUR", date(2025, 3, 15)) == D("0.9037")
    assert table.rate("JPY", date(2025, 3, 14)) == D("146.3015")
    assert table.rate("VND", date(2024, 10, 1)) == D("25201.84")
    assert table.currencies() == {"USD", "EUR", "GBP", "JPY", "SEK", "VND"}


# --- invoices in a currency -------------------------------------------------------------

def test_jpy_invoice(s):
    inv = s.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")
    assert inv.currency == "JPY"
    assert [(l.description, l.amount) for l in inv.lines] == [("Pro 2026-01-10..2026-02-10", D("4500"))]
    assert (inv.subtotal, inv.tax, inv.discount, inv.total) == (D("4500"), D("450"), D("0"), D("4950"))
    assert inv.total_usd == D("33.00")
    nxt = s.renew(inv.subscription_id)  # 2026-02-10: rate 160
    assert nxt.fx_rate == D("160.00") and nxt.subtotal == D("4800") and nxt.total == D("5280")
    assert s.subscription(inv.subscription_id).currency == "JPY"


def test_euro_invoice_with_fixed_usd_coupon(s):
    inv = s.subscribe("c1", "basic", "DE", date(2026, 1, 5), coupon_code="FIVE", currency="EUR")
    # 10 USD x 0.95 = 9.50; tax 1.805 -> 1.80; coupon 5 USD x 0.95 = 4.75 (after tax)
    assert (inv.subtotal, inv.tax, inv.discount, inv.total) == (D("9.50"), D("1.80"), D("4.75"), D("6.55"))
    assert inv.total_usd == D("6.89")  # 6.55 / 0.95 = 6.894..


def test_percent_coupon_rounds_to_whole_yen(s):
    inv = s.subscribe("c1", "pro", "JP", date(2026, 1, 10), coupon_code="P15", currency="JPY")
    # 15% of 4950 = 742.5 -> 742 (half-even, whole yen)
    assert inv.discount == D("742") and inv.total == D("4208")


def test_upgrade_converted_on_its_own_date(s):
    sid = s.subscribe("c1", "basic", "GB", date(2026, 1, 5), currency="EUR").subscription_id
    s.renew(sid)  # cycle 2026-02-05..2026-03-05
    up = s.change_plan(sid, "pro", date(2026, 2, 6))  # EUR rate 0.80
    assert [(l.description, l.amount) for l in up.lines] == [("Upgrade to Pro", D("24.00"))]
    assert up.tax == D("4.80") and up.total == D("28.80") and up.fx_rate == D("0.8000")
    assert up.total_usd == D("36.00")


def test_unknown_currency_changes_nothing(fx):
    s = BillingService(PLANS, fx=fx)
    with pytest.raises(BillingError) as e:
        s.subscribe("c1", "basic", "DE", date(2026, 1, 5), currency="CHF")
    assert code(e) == "UNKNOWN_CURRENCY"
    plain = BillingService(PLANS)
    with pytest.raises(BillingError) as e:
        plain.subscribe("c1", "basic", "DE", date(2026, 1, 5), currency="EUR")
    assert code(e) == "UNKNOWN_CURRENCY"
    assert plain.invoices() == [] and s.invoices() == []
    assert s.subscribe("c1", "basic", "US", date(2026, 1, 5)).subscription_id == "SUB-0001"


def test_usd_defaults_unchanged():
    s = BillingService(PLANS)
    inv = s.subscribe("c1", "basic", "DE", date(2026, 1, 5))
    assert inv.currency == "USD" and inv.fx_rate == D("1") and inv.total_usd == D("11.90")
    note = s.refund(inv.number, D("1.90"))
    assert note.currency == "USD" and note.amount_usd == D("1.90")


def test_refund_amount_decimals_follow_currency(s):
    inv = s.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("10.5"))
    assert code(e) == "INVALID_AMOUNT"
    note = s.refund(inv.number, D("1500"))
    assert note.tax_portion == D("136")  # 1500 x 450 / 4950 = 136.36
    usd = s.subscribe("c2", "basic", "US", date(2026, 1, 10))
    with pytest.raises(BillingError) as e:
        s.refund(usd.number, D("1.234"))
    assert code(e) == "INVALID_AMOUNT"


def test_export(s):
    s.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")
    s.subscribe("c2", "basic", "US", date(2026, 1, 12))
    data = json.loads(export_json(s.invoices()))
    assert data[0]["currency"] == "JPY" and data[0]["total"] == "4950" and data[0]["total_usd"] == "33.00"
    assert data[0]["lines"][0]["amount"] == "4500"
    assert data[1]["currency"] == "USD" and data[1]["total"] == "10.00" and data[1]["total_usd"] == "10.00"
    header = export_csv(s.invoices()).split("\n")[0]
    assert header == "number,customer_id,subscription_id,country,issued_on,subtotal,discount,tax,total,refunded,status"
