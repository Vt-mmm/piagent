# Hidden acceptance checks for TODO.md (the soak oracle lays this over the agent's work).
import copy
import importlib
import json
import unittest
import warnings
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parents[1]
FIXTURES = ROOT / "shared" / "contracts" / "fixtures"

V2 = {
    "contract_version": 2,
    "order_id": "O-9",
    "account_id": "A-9",
    "account_tier": "gold",
    "currency": "VND",
    "items": [{"sku": "S1", "qty": 3, "unit_price": 1001}, {"sku": "S2", "qty": 1, "unit_price": 7}],
}
V1 = {
    "contract_version": 1,
    "order_id": "O-8",
    "customer_id": "C-8",
    "customer_tier": "vip",
    "currency": "USD",
    "items": [{"sku": "S1", "qty": 2, "unit_price": 1999}],
}


def pricing():
    return importlib.import_module("pricing")


def read(data):
    """parse_order with warnings recorded → (order, [warning categories])."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        order = pricing().parse_order(copy.deepcopy(data))
    return order, [w.category for w in caught]


def error_code(data):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            pricing().parse_order(copy.deepcopy(data))
        except pricing().ContractError as error:
            return error.code
    return None


class HiddenAccountModule(unittest.TestCase):
    def test_account_api(self):
        account = importlib.import_module("pricing.account")
        p = pricing()
        self.assertIs(p.Account, account.Account)
        self.assertEqual(tuple(p.ACCOUNT_TIERS), ("standard", "gold", "vip"))
        self.assertEqual([p.account_discount_rate(t) for t in ("standard", "gold", "vip")], [0, 5, 10])
        with self.assertRaises(ValueError):
            p.account_discount_rate("platinum")
        self.assertEqual(p.Account("A-1", "X", "gold").account_id, "A-1")

    def test_load_accounts(self):
        p = pricing()
        accounts = p.load_accounts(SERVICE / "fixtures" / "accounts.json")
        self.assertEqual(len(accounts), 3)
        self.assertTrue(all(isinstance(a, p.Account) for a in accounts.values()))
        self.assertEqual({a.account_id for a in accounts.values()}, set(accounts))
        raw = json.loads((SERVICE / "fixtures" / "accounts.json").read_text(encoding="utf-8"))
        self.assertEqual(list(raw), ["accounts"])
        self.assertTrue(all("account_id" in row for row in raw["accounts"]))

    def test_old_names_are_gone(self):
        p = pricing()
        for name in ("Customer", "CUSTOMER_TIERS", "customer_discount_rate", "load_customers"):
            self.assertFalse(hasattr(p, name), name)
        with self.assertRaises(ImportError):
            importlib.import_module("pricing.customer")

    def test_version_bumped(self):
        self.assertEqual(pricing().__version__, "2.0.0")


class HiddenReader(unittest.TestCase):
    def test_reads_v2_without_warning(self):
        order, categories = read(V2)
        self.assertEqual((order.order_id, order.account_id, order.account_tier, order.source_version), ("O-9", "A-9", "gold", 2))
        self.assertNotIn(DeprecationWarning, categories)
        self.assertFalse(hasattr(order, "customer_id"))

    def test_reads_v1_through_shim_with_warning(self):
        order, categories = read(V1)
        self.assertEqual((order.account_id, order.account_tier, order.source_version), ("C-8", "vip", 1))
        self.assertIn(DeprecationWarning, categories)
        legacy = dict(V1)
        del legacy["contract_version"]
        order, categories = read(legacy)
        self.assertEqual((order.account_id, order.source_version), ("C-8", 1))
        self.assertIn(DeprecationWarning, categories)

    def test_writer_always_writes_v2(self):
        order, _ = read(V1)
        self.assertEqual(list(order.to_dict()), ["contract_version", "order_id", "account_id", "account_tier", "currency", "items"])
        self.assertEqual(order.to_dict(), {**{k: v for k, v in V1.items() if not k.startswith("customer")},
                                           "contract_version": 2, "account_id": "C-8", "account_tier": "vip",
                                           "order_id": "O-8", "currency": "USD", "items": V1["items"]})
        order, _ = read(V2)
        self.assertEqual(order.to_dict(), V2)
        self.assertEqual(list(order.to_dict()), list(V2))

    def test_mixed_fields(self):
        self.assertEqual(error_code({**V2, "customer_id": "C-1"}), "MIXED_FIELDS")
        self.assertEqual(error_code({**V2, "customer_tier": "gold"}), "MIXED_FIELDS")
        self.assertEqual(error_code({**V1, "account_id": "A-1"}), "MIXED_FIELDS")
        legacy = {k: v for k, v in V1.items() if k != "contract_version"}
        self.assertEqual(error_code({**legacy, "account_tier": "gold"}), "MIXED_FIELDS")

    def test_unsupported_versions(self):
        for version in (0, 4, "2", "1", 2.5):
            self.assertEqual(error_code({**V2, "contract_version": version}), "UNSUPPORTED_VERSION", version)

    def test_still_validates(self):
        self.assertEqual(error_code({**V2, "account_id": ""}), "INVALID")
        self.assertEqual(error_code({**V2, "account_tier": "platinum"}), "INVALID")
        self.assertEqual(error_code({**V2, "items": []}), "INVALID")
        self.assertEqual(error_code({**V1, "customer_tier": "platinum"}), "INVALID")
        self.assertEqual(error_code({**V1, "items": [{"sku": "A", "qty": 0, "unit_price": 1}]}), "INVALID")


class HiddenCompatShim(unittest.TestCase):
    def test_upgrade_v1(self):
        shim = importlib.import_module("pricing.compat_v1")
        self.assertIs(pricing().upgrade_v1, shim.upgrade_v1)
        data = {**copy.deepcopy(V1), "note": "giữ nguyên"}
        before = copy.deepcopy(data)
        upgraded = shim.upgrade_v1(data)
        self.assertEqual(data, before)
        self.assertEqual(upgraded["contract_version"], 2)
        self.assertEqual((upgraded["account_id"], upgraded["account_tier"], upgraded["note"]), ("C-8", "vip", "giữ nguyên"))
        self.assertNotIn("customer_id", upgraded)
        self.assertNotIn("customer_tier", upgraded)
        self.assertEqual(upgraded["items"], V1["items"])


class HiddenQuote(unittest.TestCase):
    def test_quote_uses_account(self):
        order, _ = read(V2)
        result = pricing().quote(order)
        self.assertEqual(result, {"order_id": "O-9", "account_id": "A-9", "currency": "VND",
                                  "subtotal": 3010, "discount": 150, "total": 2860})
        order, _ = read(V1)
        self.assertEqual(pricing().quote(order)["discount"], 399)


class HiddenContract(unittest.TestCase):
    def test_schema_v2(self):
        schema = json.loads((ROOT / "shared" / "contracts" / "order.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["x-contract-version"], 2)
        self.assertEqual(schema["$id"], "https://contracts.shopflow.test/order/v2")
        self.assertEqual(schema["properties"]["contract_version"], {"const": 2})
        self.assertIn("account_id", schema["required"])
        self.assertIn("account_tier", schema["required"])
        self.assertEqual(schema["properties"]["account_tier"]["enum"], ["standard", "gold", "vip"])
        self.assertNotIn("customer_id", json.dumps(schema))

    def test_samples(self):
        names = sorted(p.name for p in FIXTURES.glob("*.json"))
        self.assertIn("order-compat-v1.json", names)
        for name in ("order-basic.json", "order-vip.json", "order-gold.json"):
            self.assertIn(name, names)
        for name in names:
            data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
            order, _ = read(data)
            if "compat" in name:
                self.assertEqual((data.get("contract_version", 1), order.source_version), (1, 1), name)
                self.assertIn("customer_id", data)
            else:
                self.assertEqual((data["contract_version"], order.source_version), (2, 2), name)
                self.assertEqual(order.to_dict(), data, name)

    def test_own_compat_tests(self):
        own = SERVICE / "tests" / "test_compat_v1.py"
        self.assertTrue(own.exists(), "tests/test_compat_v1.py is missing")
        self.assertIn("upgrade_v1", own.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
