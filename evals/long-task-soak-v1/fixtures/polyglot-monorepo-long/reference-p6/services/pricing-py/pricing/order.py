"""Read and write order payloads (shared/contracts/order.schema.json, order.v3.schema.json)."""

import re
import warnings
from dataclasses import dataclass
from typing import List

from .account import ACCOUNT_TIERS
from .compat_v1 import LEGACY_FIELDS, is_v1, upgrade_v1

CONTRACT_VERSION = 2  # what the writer produces when no conversion is needed
LATEST_VERSION = 3
SUPPORTED_VERSIONS = (2, 3)
NEW_FIELDS = tuple(LEGACY_FIELDS.values())
SETTLEMENT_FIELDS = ("settlement_currency", "fx_rate_ppm")
PPM = 1000000
MAX_FX_RATE_PPM = 1000000000
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
    settlement_currency: str = ""
    fx_rate_ppm: int = PPM

    @property
    def converts(self):
        """True when the order settles in another currency (or at a non-identity rate)."""
        return (self.settlement_currency or self.currency) != self.currency or self.fx_rate_ppm != PPM

    def to_dict(self):
        """The lowest contract version that can carry the order: v2, or v3 when it converts."""
        data = {
            "contract_version": LATEST_VERSION if self.converts else CONTRACT_VERSION,
            "order_id": self.order_id,
            "account_id": self.account_id,
            "account_tier": self.account_tier,
            "currency": self.currency,
        }
        if self.converts:
            data["settlement_currency"] = self.settlement_currency
            data["fx_rate_ppm"] = self.fx_rate_ppm
        data["items"] = [{"sku": i.sku, "qty": i.qty, "unit_price": i.unit_price} for i in self.items]
        return data


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _text(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ContractError("INVALID", "%s must be a non-empty string" % key)
    return value


def _currency(data, key):
    value = _text(data, key)
    if not CURRENCY.fullmatch(value):
        raise ContractError("INVALID", "%s must be a 3-letter code" % key)
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


def _settlement(data, currency):
    settlement = _currency(data, "settlement_currency")
    rate = data.get("fx_rate_ppm")
    if not _is_int(rate) or not 1 <= rate <= MAX_FX_RATE_PPM:
        raise ContractError("INVALID", "fx_rate_ppm must be an integer from 1 to %d" % MAX_FX_RATE_PPM)
    if settlement == currency and rate != PPM:
        raise ContractError("INVALID", "fx_rate_ppm must be %d when settlement_currency equals currency" % PPM)
    return settlement, rate


def parse_order(data):
    """Validate a v3, v2 (or legacy v1) payload and return an Order."""
    if not isinstance(data, dict):
        raise ContractError("INVALID", "order must be an object")
    if is_v1(data):
        if any(key in data for key in NEW_FIELDS + SETTLEMENT_FIELDS):
            raise ContractError("MIXED_FIELDS", "a v1 payload cannot carry v2/v3 fields")
        warnings.warn("order contract v1 is deprecated; send contract_version 2 or 3", DeprecationWarning, stacklevel=2)
        data, source_version = upgrade_v1(data), 1
    else:
        source_version = data["contract_version"]
        if not _is_int(source_version) or source_version not in SUPPORTED_VERSIONS:
            raise ContractError("UNSUPPORTED_VERSION", "unsupported contract_version: %r" % (source_version,))
        if any(key in data for key in LEGACY_FIELDS):
            raise ContractError("MIXED_FIELDS", "a v%d payload cannot carry v1 fields" % source_version)
        if source_version == 2 and any(key in data for key in SETTLEMENT_FIELDS):
            raise ContractError("MIXED_FIELDS", "a v2 payload cannot carry v3 fields")
    tier = data.get("account_tier")
    if tier not in ACCOUNT_TIERS:
        raise ContractError("INVALID", "account_tier must be one of %s" % ", ".join(ACCOUNT_TIERS))
    currency = _currency(data, "currency")
    order_id = _text(data, "order_id")
    account_id = _text(data, "account_id")
    if account_id != account_id.strip():
        raise ContractError("INVALID", "account_id must not have leading or trailing whitespace")
    items = _items(data.get("items"))
    settlement, rate = _settlement(data, currency) if source_version == 3 else (currency, PPM)
    return Order(order_id, account_id, tier, currency, items, source_version, settlement, rate)
