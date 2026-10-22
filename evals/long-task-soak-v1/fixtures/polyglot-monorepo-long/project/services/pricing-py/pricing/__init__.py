"""Pricing service: quotes for orders that follow shared/contracts/order.schema.json."""

__version__ = "1.4.0"

from .customer import CUSTOMER_TIERS, Customer, customer_discount_rate, load_customers
from .order import ContractError, Item, Order, parse_order
from .quote import quote

__all__ = [
    "CUSTOMER_TIERS",
    "ContractError",
    "Customer",
    "Item",
    "Order",
    "customer_discount_rate",
    "load_customers",
    "parse_order",
    "quote",
]
