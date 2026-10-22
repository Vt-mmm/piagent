from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import List, Optional


@dataclass
class InvoiceLine:
    description: str
    amount: Decimal


@dataclass
class Invoice:
    number: str
    customer_id: str
    subscription_id: str
    country: str
    issued_on: date
    lines: List[InvoiceLine] = field(default_factory=list)
    subtotal: Decimal = Decimal("0.00")
    discount: Decimal = Decimal("0.00")
    tax: Decimal = Decimal("0.00")
    total: Decimal = Decimal("0.00")
    coupon_code: Optional[str] = None
    refunded: Decimal = Decimal("0.00")
    status: str = "paid"
    currency: str = "USD"
    fx_rate: Decimal = Decimal(1)
    total_usd: Decimal = Decimal("0.00")
