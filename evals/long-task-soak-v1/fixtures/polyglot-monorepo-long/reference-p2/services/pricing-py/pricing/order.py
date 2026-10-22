"""Read and write order payloads (shared/contracts/order.schema.json)."""

import re
import warnings
from dataclasses import dataclass
from typing import List

from .account import ACCOUNT_TIERS
from .compat_v1 import LEGACY_FIELDS, is_v1, upgrade_v1

CONTRACT_VERSION = 2
NEW_FIELDS = tuple(LEGACY_FIELDS.values())
CURRENCY = re.compile(r"[A-Z]{3}")


class ContractError(ValueError):
    """A payload that does not follow the order contract."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Item:
    sku: str
    qty: int
    unit_price: int


@dataclass(frozen=True)
class Order:
    order_id: str
    account_id: str
    account_tier: str
    currency: str
    items: List[Item]
    source_version: int = CONTRACT_VERSION

    def to_dict(self):
        return {
            "contract_version": CONTRACT_VERSION,
            "order_id": self.order_id,
            "account_id": self.account_id,
            "account_tier": self.account_tier,
            "currency": self.currency,
            "items": [{"sku": i.sku, "qty": i.qty, "unit_price": i.unit_price} for i in self.items],
        }


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _text(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ContractError("INVALID", "%s must be a non-empty string" % key)
    return value


def _items(raw):
    if not isinstance(raw, list) or not raw:
        raise ContractError("INVALID", "items must be a non-empty list")
    items = []
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise ContractError("INVALID", "items[%d] must be an object" % index)
        sku = _text(row, "sku")
        qty, price = row.get("qty"), row.get("unit_price")
        if not _is_int(qty) or qty < 1:
            raise ContractError("INVALID", "items[%d].qty must be a positive integer" % index)
        if not _is_int(price) or price < 0:
            raise ContractError("INVALID", "items[%d].unit_price must be a non-negative integer" % index)
        items.append(Item(sku, qty, price))
    return items


def parse_order(data):
    """Validate a v2 (or legacy v1) payload and return an Order."""
    if not isinstance(data, dict):
        raise ContractError("INVALID", "order must be an object")
    source_version = CONTRACT_VERSION
    if is_v1(data):
        if any(key in data for key in NEW_FIELDS):
            raise ContractError("MIXED_FIELDS", "a v1 payload cannot carry v2 fields")
        warnings.warn("order contract v1 is deprecated; send contract_version 2", DeprecationWarning, stacklevel=2)
        data, source_version = upgrade_v1(data), 1
    else:
        version = data["contract_version"]
        if not _is_int(version) or version != CONTRACT_VERSION:
            raise ContractError("UNSUPPORTED_VERSION", "unsupported contract_version: %r" % (version,))
        if any(key in data for key in LEGACY_FIELDS):
            raise ContractError("MIXED_FIELDS", "a v2 payload cannot carry v1 fields")
    tier = data.get("account_tier")
    if tier not in ACCOUNT_TIERS:
        raise ContractError("INVALID", "account_tier must be one of %s" % ", ".join(ACCOUNT_TIERS))
    currency = _text(data, "currency")
    if not CURRENCY.fullmatch(currency):
        raise ContractError("INVALID", "currency must be a 3-letter code")
    return Order(
        order_id=_text(data, "order_id"),
        account_id=_text(data, "account_id"),
        account_tier=tier,
        currency=currency,
        items=_items(data.get("items")),
        source_version=source_version,
    )
