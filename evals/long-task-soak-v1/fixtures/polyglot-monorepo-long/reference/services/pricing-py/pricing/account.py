"""Accounts and their pricing tier."""

import json
from dataclasses import dataclass

ACCOUNT_TIERS = ("standard", "gold", "vip")

# Discount per account tier, in percent of the subtotal.
_DISCOUNT_PERCENT = {"standard": 0, "gold": 5, "vip": 10}


@dataclass(frozen=True)
class Account:
    account_id: str
    name: str
    tier: str = "standard"


def account_discount_rate(tier):
    """Percent discount for an account tier."""
    if tier not in _DISCOUNT_PERCENT:
        raise ValueError("unknown account tier: %r" % (tier,))
    return _DISCOUNT_PERCENT[tier]


def load_accounts(path):
    """Read an accounts file ({"accounts": [...]}) into {account_id: Account}."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    accounts = {}
    for row in data["accounts"]:
        tier = row.get("tier", "standard")
        if tier not in ACCOUNT_TIERS:
            raise ValueError("unknown account tier: %r" % (tier,))
        accounts[row["account_id"]] = Account(row["account_id"], row["name"], tier)
    return accounts
