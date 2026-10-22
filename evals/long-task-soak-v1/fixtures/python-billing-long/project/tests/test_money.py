from decimal import Decimal

import pytest

from billing import BillingError, Plan, BillingService, format_money, to_money


def test_to_money_accepts_decimal_int_and_str():
    assert to_money("12.5") == Decimal("12.5")
    assert to_money(3) == Decimal(3)


def test_to_money_refuses_floats():
    with pytest.raises(BillingError) as err:
        to_money(1.1)
    assert err.value.code == "INVALID_AMOUNT"


def test_format_money_has_two_decimals():
    assert format_money(Decimal("12.3")) == "12.30"


def test_unknown_plan():
    service = BillingService([Plan("basic", "Basic", Decimal("10.00"))])
    with pytest.raises(BillingError) as err:
        service.plan("gold")
    assert err.value.code == "UNKNOWN_PLAN"
