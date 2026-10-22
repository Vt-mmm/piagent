# Hidden acceptance (p3): contract v3 (settlement_currency, fx_rate_ppm) in pricing-py.
import copy
import importlib
import json
import unittest
import warnings
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parents[1]
CONTRACTS = ROOT / "shared" / "contracts"

V3 = {"contract_version": 3, "order_id": "O-31", "account_id": "A-31", "account_tier": "vip", "currency": "USD",
      "settlement_currency": "VND", "fx_rate_ppm": 25350000000 // 1000, "items": [{"sku": "S1", "qty": 3, "unit_price": 1999}]}
V2 = {"contract_version": 2, "order_id": "O-21", "account_id": "A-21", "account_tier": "gold", "currency": "EUR",
      "items": [{"sku": "S1", "qty": 1, "unit_price": 10001}]}


def p():
    return importlib.import_module("pricing")


def read(data):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return p().parse_order(copy.deepcopy(data))


def code(data):
    try:
        read(data)
    except p().ContractError as error:
        return error.code
    return None


class HiddenV3(unittest.TestCase):
    def test_reads_v3(self):
        order = read(V3)
        self.assertEqual((order.source_version, order.settlement_currency, order.fx_rate_ppm), (3, "VND", 25350000))
        self.assertEqual(p().quote(order)["total"], 5398)
        self.assertEqual(p().settlement_total(order), 5398 * 25350000 // 1000000)

    def test_v1_v2_default_settlement(self):
        order = read(V2)
        self.assertEqual((order.settlement_currency, order.fx_rate_ppm, order.source_version), ("EUR", 1000000, 2))
        self.assertEqual(p().settlement_total(order), p().quote(order)["total"])

    def test_writer_lowest_version(self):
        self.assertEqual(list(read(V3).to_dict()), ["contract_version", "order_id", "account_id", "account_tier", "currency",
                                                  "settlement_currency", "fx_rate_ppm", "items"])
        self.assertEqual(read(V3).to_dict(), V3)
        same = {**V3, "settlement_currency": "USD", "fx_rate_ppm": 1000000}
        self.assertEqual(read(same).to_dict(), {k: v for k, v in V3.items() if k not in ("settlement_currency", "fx_rate_ppm")} | {"contract_version": 2})
        self.assertEqual(read(V2).to_dict(), V2)

    def test_codes(self):
        self.assertEqual(code({**V2, "fx_rate_ppm": 1000000}), "MIXED_FIELDS")
        self.assertEqual(code({**V2, "settlement_currency": "EUR"}), "MIXED_FIELDS")
        self.assertEqual(code({**V3, "customer_tier": "vip"}), "MIXED_FIELDS")
        self.assertEqual(code({**V3, "contract_version": 4}), "UNSUPPORTED_VERSION")
        self.assertEqual(code({**V3, "contract_version": "3"}), "UNSUPPORTED_VERSION")
        for bad in ({"fx_rate_ppm": 0}, {"fx_rate_ppm": 1000000001}, {"fx_rate_ppm": "25350000"}, {"fx_rate_ppm": 2.5},
                    {"settlement_currency": "vnd"}, {"settlement_currency": "USD"}, {"settlement_currency": ""}):
            self.assertEqual(code({**V3, **bad}), "INVALID", bad)
        missing = dict(V3)
        del missing["fx_rate_ppm"]
        self.assertEqual(code(missing), "INVALID")

    def test_exact_big_settlement(self):
        big = {**V3, "account_tier": "standard", "fx_rate_ppm": 796870377, "items": [{"sku": "B", "qty": 1, "unit_price": 424946923}]}
        self.assertEqual(p().settlement_total(read(big)), 338627614735)


class HiddenV3Repo(unittest.TestCase):
    def test_schema_and_samples(self):
        schema = json.loads((CONTRACTS / "order.v3.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["x-contract-version"], 3)
        self.assertEqual(schema["$id"], "https://contracts.shopflow.test/order/v3")
        self.assertEqual(schema["properties"]["contract_version"], {"const": 3})
        for key in ("settlement_currency", "fx_rate_ppm"):
            self.assertIn(key, schema["required"])
        v2 = json.loads((CONTRACTS / "order.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(v2["x-contract-version"], 2)
        samples = sorted((CONTRACTS / "fixtures" / "v3").glob("*.json"))
        self.assertGreaterEqual(len(samples), 2)
        converting = 0
        for path in samples:
            data = json.loads(path.read_text(encoding="utf-8"))
            order = read(data)
            self.assertEqual(order.source_version, 3, path.name)
            if data["settlement_currency"] != data["currency"]:
                converting += 1
                self.assertEqual(order.to_dict(), data, path.name)
        self.assertGreaterEqual(converting, 1)

    def test_own_property_and_conformance(self):
        prop = SERVICE / "tests" / "test_property_v3.py"
        self.assertTrue(prop.exists(), "tests/test_property_v3.py is missing")
        self.assertRegex(prop.read_text(encoding="utf-8"), r"random\.Random\(")
        for rel in ("services/web-js/test/property-v3.test.js", "services/ledger-go/ledger/property_test.go"):
            self.assertTrue((ROOT / rel).exists(), rel + " is missing")
        text = "".join(path.read_text(encoding="utf-8") for path in (CONTRACTS / "conformance").glob("*.json"))
        self.assertIn('"settlement_currency"', text, "no v3 conformance case")


if __name__ == "__main__":
    unittest.main()
