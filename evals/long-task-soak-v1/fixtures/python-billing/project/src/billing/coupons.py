from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional


@dataclass
class Coupon:
    code: str
    kind: str  # "percent" | "fixed"
    value: Decimal
    valid_from: Optional[date] = None
    valid_until: Optional[date] = None
    max_redemptions: Optional[int] = None
    cycles: Optional[int] = None
