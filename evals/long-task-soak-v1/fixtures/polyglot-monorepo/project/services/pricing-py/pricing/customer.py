"""Customers and their pricing tier."""

import json
from dataclasses import dataclass

CUSTOMER_TIERS = ("standard", "gold", "vip")

# Discount per customer tier, in percent of the subtotal.
_DISCOUNT_PERCENT = {"standard": 0, "gold": 5, "vip": 10}


@dataclass(frozen=True)
class Customer:
    customer_id: str
    name: str
    tier: str = "standard"


def customer_discount_rate(tier):
    """Percent discount for a customer tier."""
    if tier not in _DISCOUNT_PERCENT:
        raise ValueError("unknown customer tier: %r" % (tier,))
    return _DISCOUNT_PERCENT[tier]


def load_customers(path):
    """Read a customers file ({"customers": [...]}) into {customer_id: Customer}."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    customers = {}
    for row in data["customers"]:
        tier = row.get("tier", "standard")
        if tier not in CUSTOMER_TIERS:
            raise ValueError("unknown customer tier: %r" % (tier,))
        customers[row["customer_id"]] = Customer(row["customer_id"], row["name"], tier)
    return customers
