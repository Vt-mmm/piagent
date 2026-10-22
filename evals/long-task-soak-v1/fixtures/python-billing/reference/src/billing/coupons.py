from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

from .errors import BillingError
from .money import round_money, to_money


@dataclass
class Coupon:
    code: str
    kind: str  # "percent" | "fixed"
    value: Decimal
    valid_from: Optional[date] = None
    valid_until: Optional[date] = None
    max_redemptions: Optional[int] = None
    cycles: Optional[int] = None

    def validate(self):
        try:
            value = to_money(self.value)
        except BillingError:
            raise BillingError("INVALID_COUPON", f"bad value {self.value!r}") from None
        if self.kind == "percent":
            ok = Decimal(0) < value <= Decimal(100)
        elif self.kind == "fixed":
            ok = value > 0
        else:
            raise BillingError("INVALID_COUPON", f"bad kind {self.kind!r}")
        if not ok:
            raise BillingError("INVALID_COUPON", f"bad value {self.value!r} for {self.kind}")
        self.value = value

    def valid_on(self, day: date) -> bool:
        return (self.valid_from is None or self.valid_from <= day) and (self.valid_until is None or day <= self.valid_until)

    def discount(self, base: Decimal) -> Decimal:
        if self.kind == "percent":
            return round_money(base * self.value / Decimal(100))
        return min(self.value, base)
