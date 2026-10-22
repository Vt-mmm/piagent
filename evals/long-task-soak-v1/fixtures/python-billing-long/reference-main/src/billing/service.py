import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

from .errors import BillingError
from .invoices import Invoice, InvoiceLine
from .money import round_money, to_money
from .refunds import CreditNote
from .tax import DEFAULT_TAX_RATES

ZERO = Decimal("0.00")


def cycle_end_for(anchor_day: int, cycle_start: date) -> date:
    year, month = (cycle_start.year + 1, 1) if cycle_start.month == 12 else (cycle_start.year, cycle_start.month + 1)
    return date(year, month, min(anchor_day, calendar.monthrange(year, month)[1]))


@dataclass
class Subscription:
    id: str
    customer_id: str
    plan_code: str
    country: str
    anchor_day: int
    cycle_start: date
    cycle_end: date
    coupon_code: Optional[str] = None
    pending_plan_code: Optional[str] = None
    cycles_billed: int = 0


class BillingService:
    def __init__(self, plans, tax_rates=None):
        self.plans = {plan.code: plan for plan in plans}
        self.tax_rates = dict(DEFAULT_TAX_RATES if tax_rates is None else tax_rates)
        self.coupons = {}
        self.redemptions = {}
        self._subscriptions = {}
        self._invoices = []
        self._credit_notes = []

    def plan(self, code):
        try:
            return self.plans[code]
        except KeyError:
            raise BillingError("UNKNOWN_PLAN", code) from None

    # §5 coupons
    def add_coupon(self, coupon):
        if coupon.code in self.coupons:
            raise BillingError("DUPLICATE_COUPON", coupon.code)
        coupon.validate()
        self.coupons[coupon.code] = coupon
        self.redemptions[coupon.code] = 0

    # §6 invoices
    def invoices(self):
        return list(self._invoices)

    def invoice(self, number):
        for invoice in self._invoices:
            if invoice.number == number:
                return invoice
        raise BillingError("UNKNOWN_INVOICE", number)

    def credit_notes(self):
        return list(self._credit_notes)

    def _issue(self, sub, issued_on, lines, coupon=None):
        subtotal = sum((line.amount for line in lines), ZERO)
        rate = self.tax_rates[sub.country]
        # Product owner: coupons apply after tax (on subtotal + tax).
        tax = round_money(subtotal * rate)
        discount = coupon.discount(subtotal + tax) if coupon else ZERO
        invoice = Invoice(
            number=f"INV-{len(self._invoices) + 1:04d}", customer_id=sub.customer_id,
            subscription_id=sub.id, country=sub.country, issued_on=issued_on, lines=lines,
            subtotal=subtotal, discount=discount, tax=tax, total=subtotal + tax - discount,
            coupon_code=coupon.code if coupon else None, refunded=ZERO, status="paid",
        )
        self._invoices.append(invoice)
        return invoice

    def _cycle_invoice(self, sub):
        plan = self.plan(sub.plan_code)
        coupon = None
        if sub.coupon_code:
            candidate = self.coupons[sub.coupon_code]
            if candidate.cycles is None or sub.cycles_billed < candidate.cycles:
                coupon = candidate
        sub.cycles_billed += 1
        line = InvoiceLine(f"{plan.name} {sub.cycle_start.isoformat()}..{sub.cycle_end.isoformat()}", plan.monthly_price)
        return self._issue(sub, sub.cycle_start, [line], coupon)

    # §7 subscriptions
    def subscribe(self, customer_id, plan_code, country, start, coupon_code=None):
        self.plan(plan_code)
        if country not in self.tax_rates:
            raise BillingError("UNKNOWN_COUNTRY", country)
        if coupon_code is not None:
            coupon = self.coupons.get(coupon_code)
            if coupon is None:
                raise BillingError("UNKNOWN_COUPON", coupon_code)
            if not coupon.valid_on(start) or (coupon.max_redemptions is not None and self.redemptions[coupon_code] >= coupon.max_redemptions):
                raise BillingError("COUPON_NOT_APPLICABLE", coupon_code)
            self.redemptions[coupon_code] += 1
        sub = Subscription(
            id=f"SUB-{len(self._subscriptions) + 1:04d}", customer_id=customer_id, plan_code=plan_code,
            country=country, anchor_day=start.day, cycle_start=start,
            cycle_end=cycle_end_for(start.day, start), coupon_code=coupon_code,
        )
        self._subscriptions[sub.id] = sub
        return self._cycle_invoice(sub)

    def subscription(self, subscription_id):
        try:
            return self._subscriptions[subscription_id]
        except KeyError:
            raise BillingError("UNKNOWN_SUBSCRIPTION", subscription_id) from None

    def renew(self, subscription_id):
        sub = self.subscription(subscription_id)
        if sub.pending_plan_code:
            sub.plan_code, sub.pending_plan_code = sub.pending_plan_code, None
        sub.cycle_start = sub.cycle_end
        sub.cycle_end = cycle_end_for(sub.anchor_day, sub.cycle_start)
        return self._cycle_invoice(sub)

    # §8 plan changes
    def change_plan(self, subscription_id, new_plan_code, on):
        sub = self.subscription(subscription_id)
        new_plan = self.plan(new_plan_code)
        if not (sub.cycle_start <= on < sub.cycle_end):
            raise BillingError("INVALID_DATE", on.isoformat())
        if new_plan_code == sub.plan_code:
            raise BillingError("SAME_PLAN", new_plan_code)
        current = self.plan(sub.plan_code)
        if new_plan.monthly_price <= current.monthly_price:
            sub.pending_plan_code = new_plan_code
            return None
        sub.plan_code, sub.pending_plan_code = new_plan_code, None
        # Product owner: an upgrade charges the full monthly price of the new plan.
        charge = round_money(new_plan.monthly_price)
        return self._issue(sub, on, [InvoiceLine(f"Upgrade to {new_plan.name}", charge)])

    # §9 refunds
    def refund(self, invoice_number, amount=None, on=None):
        invoice = self.invoice(invoice_number)
        remaining = invoice.total - invoice.refunded
        if amount is None:
            amount = remaining
        else:
            amount = to_money(amount)
            if amount <= 0:
                raise BillingError("INVALID_AMOUNT", str(amount))
        if amount <= 0 or amount > remaining:
            raise BillingError("REFUND_EXCEEDS", f"{amount} > {remaining}")
        earlier = [note for note in self._credit_notes if note.invoice_number == invoice_number]
        if amount == remaining:
            tax_portion = invoice.tax - sum((note.tax_portion for note in earlier), ZERO)
        else:
            tax_portion = round_money(amount * invoice.tax / invoice.total)
        note = CreditNote(
            number=f"CN-{len(self._credit_notes) + 1:04d}", invoice_number=invoice_number,
            amount=amount, tax_portion=tax_portion, issued_on=on or invoice.issued_on,
        )
        self._credit_notes.append(note)
        invoice.refunded += amount
        invoice.status = "refunded" if invoice.refunded == invoice.total else "partially_refunded"
        return note
