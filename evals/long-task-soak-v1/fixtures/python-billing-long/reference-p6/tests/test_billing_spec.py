"""Tests for SPEC.md §1-§10, with the product owner's answers:
rounding is half-even, coupons apply after tax, upgrades charge the full
monthly price of the new plan."""
import json
from datetime import date
from decimal import Decimal as D

import pytest

from billing import BillingError, BillingService, Coupon, Plan, export_csv, export_json, round_money

PLANS = [Plan("basic", "Basic", D("10.00")), Plan("pro", "Pro", D("30.00")), Plan("odd", "Odd", D("13.50"))]


@pytest.fixture
def s():
    return BillingService(PLANS)


def test_round_half_even():
    assert round_money(D("0.125")) == D("0.12")
    assert round_money(D("0.135")) == D("0.14")


def test_tax_by_country(s):
    assert s.subscribe("c", "odd", "DE", date(2026, 1, 1)).tax == D("2.56")
    with pytest.raises(BillingError) as e:
        s.subscribe("c", "odd", "XX", date(2026, 1, 1))
    assert e.value.code == "UNKNOWN_COUNTRY"


def test_coupon_after_tax(s):
    s.add_coupon(Coupon("TEN", "fixed", D("10")))
    inv = s.subscribe("c", "basic", "JP", date(2026, 1, 1), coupon_code="TEN")
    assert (inv.tax, inv.discount, inv.total) == (D("1.00"), D("10.00"), D("1.00"))


def test_coupon_rules(s):
    s.add_coupon(Coupon("ONE", "percent", D("50"), max_redemptions=1, cycles=1))
    inv = s.subscribe("c", "basic", "US", date(2026, 1, 1), coupon_code="ONE")
    assert inv.discount == D("5.00")
    assert s.renew(inv.subscription_id).discount == D("0")
    with pytest.raises(BillingError) as e:
        s.subscribe("d", "basic", "US", date(2026, 1, 1), coupon_code="ONE")
    assert e.value.code == "COUPON_NOT_APPLICABLE"
    with pytest.raises(BillingError) as e:
        s.add_coupon(Coupon("BAD", "percent", D("150")))
    assert e.value.code == "INVALID_COUPON"


def test_cycles_anchor(s):
    inv = s.subscribe("c", "pro", "US", date(2026, 1, 31))
    assert inv.lines[0].description == "Pro 2026-01-31..2026-02-28"
    assert s.renew(inv.subscription_id).lines[0].description == "Pro 2026-02-28..2026-03-31"


def test_upgrade_full_month_and_downgrade_pending(s):
    sid = s.subscribe("c", "basic", "US", date(2026, 1, 1)).subscription_id
    up = s.change_plan(sid, "pro", date(2026, 1, 20))
    assert [(l.description, l.amount) for l in up.lines] == [("Upgrade to Pro", D("30.00"))]
    assert s.change_plan(sid, "basic", date(2026, 1, 21)) is None
    assert s.subscription(sid).pending_plan_code == "basic"
    assert s.renew(sid).subtotal == D("10.00")


def test_refunds(s):
    inv = s.subscribe("c", "odd", "DE", date(2026, 1, 1))
    assert s.refund(inv.number, D("5")).tax_portion == D("0.80")
    assert s.refund(inv.number).tax_portion == D("1.76")
    assert inv.status == "refunded"
    with pytest.raises(BillingError) as e:
        s.refund(inv.number, D("1"))
    assert e.value.code == "REFUND_EXCEEDS"


def test_export(s):
    s.subscribe("a,b", "basic", "US", date(2026, 1, 1))
    text = export_csv(s.invoices())
    assert text.splitlines()[1] == 'INV-2026-00001,"a,b",SUB-0001,US,2026-01-01,10.00,0.00,0.00,10.00,0.00,paid'
    assert json.loads(export_json(s.invoices()))[0]["lines"][0]["amount"] == "10.00"
