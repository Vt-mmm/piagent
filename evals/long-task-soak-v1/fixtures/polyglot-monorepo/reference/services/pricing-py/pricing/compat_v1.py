"""Compat shim for legacy v1 order payloads (customer_id / customer_tier).

Readers accept v1 payloads for the whole 2.x line; this shim goes away in 3.0.0.
"""

LEGACY_FIELDS = {"customer_id": "account_id", "customer_tier": "account_tier"}


def is_v1(data):
    """A payload is v1 when it says contract_version 1 or has no contract_version."""
    return "contract_version" not in data or (
        data["contract_version"] == 1 and not isinstance(data["contract_version"], bool)
    )


def upgrade_v1(data):
    """Return a new v2 dict for a v1 payload; the input is left unchanged."""
    upgraded = {}
    for key, value in data.items():
        if key == "contract_version":
            continue
        upgraded[LEGACY_FIELDS.get(key, key)] = value
    upgraded["contract_version"] = 2
    return upgraded
