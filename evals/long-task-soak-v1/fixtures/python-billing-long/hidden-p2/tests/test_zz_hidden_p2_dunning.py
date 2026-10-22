# Hidden acceptance checks for docs/DUNNING.md plus the product owner's decision:
#   suspension -> access ends immediately on suspension (not at the end of the paid period)
# The soak oracle lays this file over the agent's work; the agent never sees it.
from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from billing import BillingError, BillingService, DunningEvent, DunningPolicy, Plan

PLANS = [Plan("basic", "Basic", D("10.00")), Plan("pro", "Pro", D("30.00"))]


def code(excinfo):
    return excinfo.value.code


def trail(events):
    return [(e.on, e.kind, e.attempt) for e in events]


def failing_service(**kw):
    s = BillingService(PLANS, **kw)
    inv = s.subscribe("c1", "basic", "US", date(2026, 1, 1))
    return s, inv, inv.subscription_id


# --- decision: access ends immediately on suspension ---------------------------------

def test_suspended_customer_loses_access_immediately():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    s.run_dunning(date(2026, 1, 20))
    sub = s.subscription(sid)
    assert sub.state == "suspended" and sub.suspended_on == date(2026, 1, 15)
    assert sub.cycle_end == date(2026, 2, 1)  # the paid period runs on, access does not
    assert s.has_access(sid, date(2026, 1, 14)) is True
    assert s.has_access(sid, date(2026, 1, 15)) is False
    assert s.has_access(sid, date(2026, 1, 20)) is False
    assert s.has_access(sid, date(2026, 1, 31)) is False


def test_access_while_past_due_and_in_grace():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    assert s.has_access(sid, date(2026, 1, 1)) is True
    s.run_dunning(date(2026, 1, 9))
    assert s.subscription(sid).state == "grace"
    assert s.has_access(sid, date(2026, 1, 9)) is True


def test_reactivation_restores_access():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    s.run_dunning(date(2026, 1, 20))
    s.pay_invoice(inv.number, date(2026, 1, 22))
    sub = s.subscription(sid)
    assert sub.state == "active" and sub.suspended_on is None
    assert s.has_access(sid, date(2026, 1, 22)) is True
    assert inv.status == "paid"
    assert trail(s.dunning_events(sid))[-1] == (date(2026, 1, 22), "reactivated", None)


# --- schedule, grace, suspension ------------------------------------------------------

def test_default_schedule_in_one_late_run():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    assert inv.status == "past_due" and s.subscription(sid).state == "past_due"
    produced = s.run_dunning(date(2026, 1, 20))
    assert trail(produced) == [
        (date(2026, 1, 2), "retry_failed", 1), (date(2026, 1, 4), "retry_failed", 2),
        (date(2026, 1, 8), "retry_failed", 3), (date(2026, 1, 8), "grace_started", None),
        (date(2026, 1, 15), "suspended", None)]
    assert all(isinstance(e, DunningEvent) and e.invoice_number == inv.number for e in produced)
    assert s.run_dunning(date(2026, 1, 20)) == []
    assert trail(s.dunning_events(sid))[0] == (date(2026, 1, 1), "payment_failed", None)
    assert len(s.dunning_events(sid)) == 6


def test_step_by_step_runs():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    assert s.run_dunning(date(2026, 1, 1)) == []
    assert trail(s.run_dunning(date(2026, 1, 3))) == [(date(2026, 1, 2), "retry_failed", 1)]
    assert s.subscription(sid).state == "past_due"
    assert trail(s.run_dunning(date(2026, 1, 8))) == [(date(2026, 1, 4), "retry_failed", 2), (date(2026, 1, 8), "retry_failed", 3), (date(2026, 1, 8), "grace_started", None)]
    assert s.run_dunning(date(2026, 1, 14)) == []
    assert s.subscription(sid).state == "grace"
    assert trail(s.run_dunning(date(2026, 1, 15))) == [(date(2026, 1, 15), "suspended", None)]


def test_gateway_success_on_second_retry():
    calls = []

    def gateway(invoice, attempt, on):
        calls.append((invoice.number, attempt, on))
        return attempt == 2

    s, inv, sid = failing_service(gateway=gateway)
    s.payment_failed(inv.number, date(2026, 1, 5))
    produced = s.run_dunning(date(2026, 2, 1))
    assert calls == [(inv.number, 1, date(2026, 1, 6)), (inv.number, 2, date(2026, 1, 8))]
    assert trail(produced) == [(date(2026, 1, 6), "retry_failed", 1), (date(2026, 1, 8), "retry_succeeded", 2)]
    assert inv.status == "paid" and s.subscription(sid).state == "active"
    assert s.run_dunning(date(2026, 3, 1)) == []


def test_custom_policy_and_zero_grace():
    s, inv, sid = failing_service(dunning=DunningPolicy(retry_days=(2, 5), grace_days=0))
    s.payment_failed(inv.number, date(2026, 1, 10))
    assert trail(s.run_dunning(date(2026, 1, 15))) == [
        (date(2026, 1, 12), "retry_failed", 1), (date(2026, 1, 15), "retry_failed", 2),
        (date(2026, 1, 15), "grace_started", None), (date(2026, 1, 15), "suspended", None)]
    assert s.subscription(sid).suspended_on == date(2026, 1, 15)


def test_invalid_policies():
    for bad in (dict(retry_days=(3, 1)), dict(retry_days=(0, 2)), dict(retry_days=(1, 1)), dict(grace_days=-1)):
        with pytest.raises(BillingError) as e:
            DunningPolicy(**bad)
        assert code(e) == "INVALID_POLICY"


def test_manual_payment_during_grace_cancels_suspension():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    s.run_dunning(date(2026, 1, 10))
    s.pay_invoice(inv.number, date(2026, 1, 11))
    assert trail(s.dunning_events(sid))[-1] == (date(2026, 1, 11), "paid", None)
    assert s.run_dunning(date(2026, 3, 1)) == []
    assert s.subscription(sid).state == "active"


def test_payment_failed_errors():
    s, inv, sid = failing_service()
    with pytest.raises(BillingError) as e:
        s.payment_failed("INV-NOPE", date(2026, 1, 2))
    assert code(e) == "UNKNOWN_INVOICE"
    with pytest.raises(BillingError) as e:
        s.payment_failed(inv.number, date(2025, 12, 31))
    assert code(e) == "INVALID_DATE"
    s.payment_failed(inv.number, date(2026, 1, 2))
    with pytest.raises(BillingError) as e:
        s.payment_failed(inv.number, date(2026, 1, 3))
    assert code(e) == "INVALID_STATE"
    second = s.renew(sid)
    with pytest.raises(BillingError) as e:
        s.payment_failed(second.number, date(2026, 2, 2))
    assert code(e) == "DUNNING_IN_PROGRESS"
    other = s.subscribe("c2", "basic", "US", date(2026, 1, 1))
    s.refund(other.number, D("1"))
    with pytest.raises(BillingError) as e:
        s.payment_failed(other.number, date(2026, 1, 2))
    assert code(e) == "INVALID_STATE"
    with pytest.raises(BillingError) as e:
        s.pay_invoice(other.number, date(2026, 1, 2))
    assert code(e) == "INVALID_STATE"


def test_suspended_blocks_renew_and_change_plan_and_past_due_blocks_refund():
    s, inv, sid = failing_service()
    s.payment_failed(inv.number, date(2026, 1, 1))
    with pytest.raises(BillingError) as e:
        s.refund(inv.number)
    assert code(e) == "INVOICE_NOT_PAID"
    s.run_dunning(date(2026, 1, 9))
    up = s.change_plan(sid, "pro", date(2026, 1, 9))  # grace still allows changes
    assert up is not None
    s.run_dunning(date(2026, 1, 16))
    for call in (lambda: s.renew(sid), lambda: s.change_plan(sid, "basic", date(2026, 1, 20))):
        with pytest.raises(BillingError) as e:
            call()
        assert code(e) == "SUBSCRIPTION_SUSPENDED"
    s.pay_invoice(inv.number, date(2026, 1, 25))
    assert s.renew(sid).issued_on == date(2026, 2, 1)


def test_several_subscriptions_in_id_order():
    s = BillingService(PLANS)
    a = s.subscribe("c1", "basic", "US", date(2026, 1, 1))
    b = s.subscribe("c2", "pro", "US", date(2026, 1, 1))
    s.payment_failed(b.number, date(2026, 1, 1))
    s.payment_failed(a.number, date(2026, 1, 2))
    produced = s.run_dunning(date(2026, 1, 3))
    assert [(e.invoice_number, e.on) for e in produced] == [(a.number, date(2026, 1, 3)), (b.number, date(2026, 1, 2))]
    with pytest.raises(BillingError) as e:
        s.dunning_events("SUB-9999")
    assert code(e) == "UNKNOWN_SUBSCRIPTION"
    assert s.dunning_events(a.subscription_id)[0].kind == "payment_failed"


def test_new_subscription_defaults():
    s = BillingService(PLANS)
    sub = s.subscription(s.subscribe("c1", "basic", "US", date(2026, 1, 1)).subscription_id)
    assert sub.state == "active" and sub.suspended_on is None
    assert s.has_access(sub.id, date(2026, 1, 1)) is True
    assert s.dunning_events(sub.id) == []
