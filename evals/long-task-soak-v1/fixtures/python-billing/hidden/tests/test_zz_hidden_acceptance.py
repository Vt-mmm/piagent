# Hidden acceptance checks for SPEC.md plus the product owner's decisions:
#   rounding  -> round half-even to cents
#   coupons   -> applied after tax (on subtotal + tax)
#   upgrades  -> charge the full monthly price of the new plan immediately
# The soak oracle lays this file over the agent's work; the agent never sees it.
import csv
import io
import json
from datetime import date
from decimal import Decimal as D

import pytest

from billing import (
    BillingError, BillingService, Coupon, Plan, export_csv, export_json, format_money, round_money,
)

PLANS = [
    Plan("basic", "Basic", D("10.00")),
    Plan("pro", "Pro", D("30.00")),
    Plan("odd", "Odd", D("13.50")),
    Plan("team", "Team", D("99.00")),
]


def service(**kw):
    return BillingService(PLANS, **kw)


def code(excinfo):
    return excinfo.value.code


# --- decision: rounding is half-even -------------------------------------------------

def test_round_money_is_half_even_to_cents():
    assert round_money(D("2.345")) == D("2.34")
    assert round_money(D("2.355")) == D("2.36")
    assert round_money(D("0.125")) == D("0.12")
    assert round_money(D("0.135")) == D("0.14")
    assert round_money(D("2.3451")) == D("2.35")
    assert round_money("1.005") == D("1.00")
    assert round_money(D("7")) == D("7.00")


def test_tax_is_rounded_half_even():
    s = service()
    inv = s.subscribe("c1", "odd", "DE", date(2026, 1, 1))
    # 13.50 x 0.19 = 2.565 -> 2.56 (half-up would give 2.57)
    assert inv.subtotal == D("13.50")
    assert inv.tax == D("2.56")
    assert inv.total == D("16.06")


# --- decision: coupons apply after tax ------------------------------------------------

def test_fixed_coupon_is_taken_after_tax():
    s = service()
    s.add_coupon(Coupon("TEN", "fixed", D("10")))
    inv = s.subscribe("c1", "team", "JP", date(2026, 1, 1), coupon_code="TEN")
    # tax on the full subtotal, then the discount
    assert inv.subtotal == D("99.00")
    assert inv.tax == D("9.90")
    assert inv.discount == D("10.00")
    assert inv.total == D("98.90")
    assert inv.coupon_code == "TEN"


def test_percent_coupon_on_subtotal_plus_tax_with_half_even():
    s = service()
    s.add_coupon(Coupon("P10", "percent", D("10")))
    inv = s.subscribe("c1", "odd", "DE", date(2026, 1, 1), coupon_code="P10")
    # tax 2.56; base 16.06; 10% = 1.606 -> 1.61; total 14.45
    assert inv.tax == D("2.56")
    assert inv.discount == D("1.61")
    assert inv.total == D("14.45")


def test_fixed_coupon_capped_at_subtotal_plus_tax():
    s = service()
    s.add_coupon(Coupon("BIG", "fixed", D("500")))
    inv = s.subscribe("c1", "basic", "GB", date(2026, 1, 1), coupon_code="BIG")
    assert inv.tax == D("2.00")
    assert inv.discount == D("12.00")
    assert inv.total == D("0.00")


def test_percent_coupon_half_even_without_tax():
    s = service()
    s.add_coupon(Coupon("Q", "percent", D("12.5")))
    inv = s.subscribe("c1", "basic", "US", date(2026, 1, 1), coupon_code="Q")
    # 12.5% of 10.00 = 1.25 exactly
    assert inv.discount == D("1.25")
    s2 = BillingService([Plan("x", "X", D("4.50"))], tax_rates={"US": D("0")})
    s2.add_coupon(Coupon("H", "percent", D("25")))
    inv2 = s2.subscribe("c2", "x", "US", date(2026, 1, 1), coupon_code="H")
    # 25% of 4.50 = 1.125 -> 1.12 (half-even)
    assert inv2.discount == D("1.12")
    assert inv2.total == D("3.38")


# --- decision: an upgrade charges the full new monthly price -------------------------

def test_upgrade_charges_full_month_of_new_plan():
    s = service()
    first = s.subscribe("c1", "basic", "US", date(2026, 1, 1))
    sub_id = first.subscription_id
    up = s.change_plan(sub_id, "pro", date(2026, 1, 16))
    assert up is not None
    assert [(l.description, l.amount) for l in up.lines] == [("Upgrade to Pro", D("30.00"))]
    assert up.issued_on == date(2026, 1, 16)
    assert up.subtotal == D("30.00") and up.total == D("30.00")
    assert up.number == "INV-0002"
    sub = s.subscription(sub_id)
    assert sub.plan_code == "pro"
    assert (sub.cycle_start, sub.cycle_end) == (date(2026, 1, 1), date(2026, 2, 1))
    nxt = s.renew(sub_id)
    assert nxt.lines[0].description == "Pro 2026-02-01..2026-03-01"
    assert nxt.total == D("30.00")


def test_upgrade_invoice_is_taxed_and_never_discounted():
    s = service()
    s.add_coupon(Coupon("HALF", "percent", D("50")))
    first = s.subscribe("c1", "basic", "JP", date(2026, 3, 10), coupon_code="HALF")
    assert first.discount == D("5.50")
    up = s.change_plan(first.subscription_id, "odd", date(2026, 4, 9))
    # full 13.50, tax 1.35, no coupon
    assert up.subtotal == D("13.50")
    assert up.tax == D("1.35")
    assert up.discount == D("0.00")
    assert up.coupon_code is None
    assert up.total == D("14.85")


def test_upgrade_on_first_day_still_charges_full_month():
    s = service()
    first = s.subscribe("c1", "basic", "US", date(2026, 2, 1))
    up = s.change_plan(first.subscription_id, "team", date(2026, 2, 1))
    assert up.total == D("99.00")


# --- plan changes (decided rules) -----------------------------------------------------

def test_downgrade_is_pending_until_renewal():
    s = service()
    first = s.subscribe("c1", "pro", "US", date(2026, 1, 1))
    sid = first.subscription_id
    assert s.change_plan(sid, "odd", date(2026, 1, 5)) is None
    assert s.change_plan(sid, "basic", date(2026, 1, 6)) is None
    sub = s.subscription(sid)
    assert sub.plan_code == "pro" and sub.pending_plan_code == "basic"
    assert len(s.invoices()) == 1
    nxt = s.renew(sid)
    assert nxt.lines[0].description == "Basic 2026-02-01..2026-03-01"
    assert nxt.total == D("10.00")
    assert s.subscription(sid).pending_plan_code is None


def test_upgrade_drops_pending_downgrade():
    s = service()
    sid = s.subscribe("c1", "pro", "US", date(2026, 1, 1)).subscription_id
    s.change_plan(sid, "basic", date(2026, 1, 2))
    s.change_plan(sid, "team", date(2026, 1, 3))
    sub = s.subscription(sid)
    assert sub.plan_code == "team" and sub.pending_plan_code is None
    assert s.renew(sid).subtotal == D("99.00")


def test_change_plan_errors():
    s = service()
    sid = s.subscribe("c1", "basic", "US", date(2026, 1, 1)).subscription_id
    with pytest.raises(BillingError) as e:
        s.change_plan(sid, "pro", date(2026, 2, 1))
    assert code(e) == "INVALID_DATE"
    with pytest.raises(BillingError) as e:
        s.change_plan(sid, "pro", date(2025, 12, 31))
    assert code(e) == "INVALID_DATE"
    with pytest.raises(BillingError) as e:
        s.change_plan(sid, "basic", date(2026, 1, 5))
    assert code(e) == "SAME_PLAN"
    with pytest.raises(BillingError) as e:
        s.change_plan(sid, "gold", date(2026, 1, 5))
    assert code(e) == "UNKNOWN_PLAN"
    with pytest.raises(BillingError) as e:
        s.change_plan("SUB-9999", "pro", date(2026, 1, 5))
    assert code(e) == "UNKNOWN_SUBSCRIPTION"


# --- cycles and invoices ----------------------------------------------------------------

def test_cycles_keep_the_anchor_day():
    s = service()
    inv = s.subscribe("c1", "pro", "US", date(2026, 1, 31))
    sid = inv.subscription_id
    assert sid == "SUB-0001"
    assert inv.lines[0].description == "Pro 2026-01-31..2026-02-28"
    assert inv.issued_on == date(2026, 1, 31)
    seen = [s.renew(sid).lines[0].description for _ in range(3)]
    assert seen == ["Pro 2026-02-28..2026-03-31", "Pro 2026-03-31..2026-04-30", "Pro 2026-04-30..2026-05-31"]
    sub = s.subscription(sid)
    assert (sub.cycle_start, sub.cycle_end) == (date(2026, 4, 30), date(2026, 5, 31))


def test_cycle_crosses_year_end():
    s = service()
    inv = s.subscribe("c1", "basic", "US", date(2026, 12, 15))
    assert inv.lines[0].description == "Basic 2026-12-15..2027-01-15"


def test_invoice_numbers_and_lookup():
    s = service()
    a = s.subscribe("c1", "basic", "US", date(2026, 1, 1))
    b = s.subscribe("c2", "pro", "VN", date(2026, 1, 2))
    assert (a.number, b.number) == ("INV-0001", "INV-0002")
    assert b.subscription_id == "SUB-0002"
    assert b.customer_id == "c2" and b.country == "VN"
    assert b.tax == D("3.00") and b.total == D("33.00")
    assert b.status == "paid" and b.refunded == D("0") and b.discount == D("0") and b.coupon_code is None
    assert [i.number for i in s.invoices()] == ["INV-0001", "INV-0002"]
    assert s.invoice("INV-0002") is b or s.invoice("INV-0002").number == "INV-0002"
    with pytest.raises(BillingError) as e:
        s.invoice("INV-0404")
    assert code(e) == "UNKNOWN_INVOICE"


def test_subscribe_errors_change_nothing():
    s = service()
    s.add_coupon(Coupon("ONCE", "fixed", D("1"), max_redemptions=1))
    with pytest.raises(BillingError) as e:
        s.subscribe("c1", "basic", "FR", date(2026, 1, 1))
    assert code(e) == "UNKNOWN_COUNTRY"
    with pytest.raises(BillingError) as e:
        s.subscribe("c1", "gold", "US", date(2026, 1, 1))
    assert code(e) == "UNKNOWN_PLAN"
    with pytest.raises(BillingError) as e:
        s.subscribe("c1", "basic", "US", date(2026, 1, 1), coupon_code="NOPE")
    assert code(e) == "UNKNOWN_COUPON"
    with pytest.raises(BillingError) as e:
        s.subscribe("c1", "basic", "FR", date(2026, 1, 1), coupon_code="ONCE")
    assert s.invoices() == []
    inv = s.subscribe("c1", "basic", "US", date(2026, 1, 1), coupon_code="ONCE")
    assert inv.number == "INV-0001" and inv.subscription_id == "SUB-0001"
    assert inv.discount == D("1.00")
    with pytest.raises(BillingError) as e:
        s.subscribe("c2", "basic", "US", date(2026, 1, 1), coupon_code="ONCE")
    assert code(e) == "COUPON_NOT_APPLICABLE"
    with pytest.raises(BillingError) as e:
        s.subscription("SUB-0002")
    assert code(e) == "UNKNOWN_SUBSCRIPTION"


def test_coupon_validation_and_window():
    s = service()
    for bad in (Coupon("A", "percent", D("0")), Coupon("B", "percent", D("101")),
                Coupon("C", "fixed", D("-1")), Coupon("D", "bogus", D("5"))):
        with pytest.raises(BillingError) as e:
            s.add_coupon(bad)
        assert code(e) == "INVALID_COUPON"
    s.add_coupon(Coupon("WIN", "fixed", D("2"), valid_from=date(2026, 3, 1), valid_until=date(2026, 3, 31)))
    with pytest.raises(BillingError) as e:
        s.add_coupon(Coupon("WIN", "fixed", D("3")))
    assert code(e) == "DUPLICATE_COUPON"
    for day in (date(2026, 2, 28), date(2026, 4, 1)):
        with pytest.raises(BillingError) as e:
            s.subscribe("c", "basic", "US", day, coupon_code="WIN")
        assert code(e) == "COUPON_NOT_APPLICABLE"
    assert s.subscribe("c", "basic", "US", date(2026, 3, 1), coupon_code="WIN").discount == D("2.00")
    assert s.subscribe("c", "basic", "US", date(2026, 3, 31), coupon_code="WIN").discount == D("2.00")


def test_coupon_cycles_limit():
    s = service()
    s.add_coupon(Coupon("TWO", "percent", D("50"), cycles=2))
    s.add_coupon(Coupon("ALL", "fixed", D("1")))
    a = s.subscribe("c1", "basic", "US", date(2026, 1, 1), coupon_code="TWO")
    b = s.subscribe("c2", "basic", "US", date(2026, 1, 1), coupon_code="ALL")
    a_disc = [a.discount] + [s.renew(a.subscription_id).discount for _ in range(3)]
    assert a_disc == [D("5.00"), D("5.00"), D("0"), D("0")]
    b_disc = [b.discount] + [s.renew(b.subscription_id).discount for _ in range(3)]
    assert b_disc == [D("1.00")] * 4
    assert s.renew(a.subscription_id).coupon_code is None


# --- refunds ----------------------------------------------------------------------------

def test_partial_then_full_refund_with_tax_portions():
    s = service()
    inv = s.subscribe("c1", "odd", "DE", date(2026, 1, 1))  # total 16.06, tax 2.56
    n1 = s.refund(inv.number, D("5.00"), on=date(2026, 1, 9))
    # 5.00 x 2.56 / 16.06 = 0.79701... -> 0.80
    assert (n1.number, n1.invoice_number, n1.amount, n1.tax_portion, n1.issued_on) == (
        "CN-0001", "INV-0001", D("5.00"), D("0.80"), date(2026, 1, 9))
    assert inv.refunded == D("5.00") and inv.status == "partially_refunded"
    n2 = s.refund(inv.number)
    assert n2.number == "CN-0002"
    assert n2.amount == D("11.06")
    assert n2.tax_portion == D("1.76")
    assert n2.issued_on == date(2026, 1, 1)
    assert inv.refunded == D("16.06") and inv.status == "refunded"
    assert [n.number for n in s.credit_notes()] == ["CN-0001", "CN-0002"]


def test_refund_tax_portion_rounds_half_even():
    s = BillingService([Plan("x", "X", D("10.00"))], tax_rates={"ZZ": D("0.25")})
    inv = s.subscribe("c", "x", "ZZ", date(2026, 1, 1))  # tax 2.50, total 12.50
    assert s.refund(inv.number, "0.25").tax_portion == D("0.05")
    assert s.refund(inv.number, "0.13").tax_portion == D("0.03")   # 0.026
    assert s.refund(inv.number, "0.11").tax_portion == D("0.02")   # 0.022
    s2 = BillingService([Plan("y", "Y", D("10.00"))], tax_rates={"ZZ": D("1")})
    inv2 = s2.subscribe("c", "y", "ZZ", date(2026, 1, 1))  # tax 10.00, total 20.00
    assert s2.refund(inv2.number, "0.25").tax_portion == D("0.12")  # 0.125 -> half-even
    assert s2.refund(inv2.number, "0.35").tax_portion == D("0.18")  # 0.175 -> half-even
    last = s2.refund(inv2.number)
    assert last.amount == D("19.40")
    assert last.tax_portion == D("9.70")  # 10.00 - 0.12 - 0.18


def test_refund_errors():
    s = service()
    inv = s.subscribe("c1", "basic", "US", date(2026, 1, 1))
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("0"))
    assert code(e) == "INVALID_AMOUNT"
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("-1"))
    assert code(e) == "INVALID_AMOUNT"
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("10.01"))
    assert code(e) == "REFUND_EXCEEDS"
    s.refund(inv.number)
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("0.01"))
    assert code(e) == "REFUND_EXCEEDS"
    with pytest.raises(BillingError) as e:
        s.refund(inv.number)
    assert code(e) == "REFUND_EXCEEDS"
    with pytest.raises(BillingError) as e:
        s.refund("INV-0404")
    assert code(e) == "UNKNOWN_INVOICE"


# --- export -----------------------------------------------------------------------------

HEADER = "number,customer_id,subscription_id,country,issued_on,subtotal,discount,tax,total,refunded,status"


def _book():
    s = service()
    s.add_coupon(Coupon("P10", "percent", D("10")))
    s.subscribe('Acme, "Inc"', "odd", "DE", date(2026, 1, 1), coupon_code="P10")
    second = s.subscribe("solo", "basic", "US", date(2026, 1, 5))
    s.refund(second.number, D("4"))
    return s


def test_export_csv():
    s = _book()
    text = export_csv(s.invoices())
    assert text.endswith("\n") and "\r" not in text
    lines = text.split("\n")
    assert lines[0] == HEADER
    assert lines[1] == 'INV-0001,"Acme, ""Inc""",SUB-0001,DE,2026-01-01,13.50,1.61,2.56,14.45,0.00,paid'
    assert lines[2] == "INV-0002,solo,SUB-0002,US,2026-01-05,10.00,0.00,0.00,10.00,4.00,partially_refunded"
    assert lines[3:] == [""]
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[1][1] == 'Acme, "Inc"'
    assert export_csv([]) == HEADER + "\n"


def test_export_json():
    s = _book()
    data = json.loads(export_json(s.invoices()))
    assert isinstance(data, list) and len(data) == 2
    first = data[0]
    for key in HEADER.split(","):
        assert key in first
    assert first["customer_id"] == 'Acme, "Inc"'
    assert first["issued_on"] == "2026-01-01"
    assert (first["subtotal"], first["discount"], first["tax"], first["total"], first["refunded"]) == (
        "13.50", "1.61", "2.56", "14.45", "0.00")
    assert first["coupon_code"] == "P10"
    assert first["lines"] == [{"description": "Odd 2026-01-01..2026-02-01", "amount": "13.50"}]
    assert data[1]["coupon_code"] is None
    assert data[1]["status"] == "partially_refunded"
    assert data[1]["refunded"] == "4.00"
    assert json.loads(export_json([])) == []


def test_format_money_still_two_decimals():
    assert format_money(D("3")) == "3.00"
