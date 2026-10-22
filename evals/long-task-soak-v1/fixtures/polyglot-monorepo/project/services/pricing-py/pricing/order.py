"""Read and write order payloads (shared/contracts/order.schema.json)."""

from dataclasses import dataclass
from typing import List

from .customer import CUSTOMER_TIERS

CONTRACT_VERSION = 1


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
    customer_id: str
    customer_tier: str
    currency: str
    items: List[Item]

    def to_dict(self):
        return {
            "contract_version": CONTRACT_VERSION,
            "order_id": self.order_id,
            "customer_id": self.customer_id,
            "customer_tier": self.customer_tier,
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
    """Validate a payload and return an Order."""
    if not isinstance(data, dict):
        raise ContractError("INVALID", "order must be an object")
    version = data.get("contract_version", CONTRACT_VERSION)
    if not _is_int(version) or version != CONTRACT_VERSION:
        raise ContractError("UNSUPPORTED_VERSION", "unsupported contract_version: %r" % (version,))
    tier = data.get("customer_tier")
    if tier not in CUSTOMER_TIERS:
        raise ContractError("INVALID", "customer_tier must be one of %s" % ", ".join(CUSTOMER_TIERS))
    currency = _text(data, "currency")
    if len(currency) != 3 or not currency.isupper():
        raise ContractError("INVALID", "currency must be a 3-letter code")
    return Order(
        order_id=_text(data, "order_id"),
        customer_id=_text(data, "customer_id"),
        customer_tier=tier,
        currency=currency,
        items=_items(data.get("items")),
    )
