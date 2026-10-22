"""Pricing service: quotes for orders that follow shared/contracts/order.schema.json (v2) and order.v3.schema.json."""

__version__ = "3.0.0"

from .account import ACCOUNT_TIERS, Account, account_discount_rate, load_accounts
from .compat_v1 import upgrade_v1
from .order import ContractError, Item, Order, parse_order
from .quote import quote, settlement_total

__all__ = [
    "ACCOUNT_TIERS",
    "Account",
    "ContractError",
    "Item",
    "Order",
    "account_discount_rate",
    "load_accounts",
    "parse_order",
    "quote",
    "settlement_total",
    "upgrade_v1",
]
