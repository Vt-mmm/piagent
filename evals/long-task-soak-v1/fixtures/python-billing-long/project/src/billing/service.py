from .errors import BillingError
from .tax import DEFAULT_TAX_RATES


class BillingService:
    def __init__(self, plans, tax_rates=None):
        self.plans = {plan.code: plan for plan in plans}
        self.tax_rates = dict(DEFAULT_TAX_RATES if tax_rates is None else tax_rates)

    def plan(self, code):
        try:
            return self.plans[code]
        except KeyError:
            raise BillingError("UNKNOWN_PLAN", code) from None

    # Everything below is still to be written (SPEC.md §5–§9).
    def add_coupon(self, coupon):
        raise NotImplementedError

    def subscribe(self, customer_id, plan_code, country, start, coupon_code=None):
        raise NotImplementedError

    def subscription(self, subscription_id):
        raise NotImplementedError

    def renew(self, subscription_id):
        raise NotImplementedError

    def change_plan(self, subscription_id, new_plan_code, on):
        raise NotImplementedError

    def refund(self, invoice_number, amount=None, on=None):
        raise NotImplementedError

    def invoices(self):
        raise NotImplementedError

    def invoice(self, number):
        raise NotImplementedError

    def credit_notes(self):
        raise NotImplementedError
