# Hidden acceptance (p2): shared contract vectors, the currency fix, and the own conformance suite.
import copy
import importlib
import json
import unittest
import warnings
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parents[1]
VECTORS = json.loads((ROOT / ".soak" / "p2" / "vectors.json").read_text(encoding="utf-8"))
CONFORMANCE = ROOT / "shared" / "contracts" / "conformance"


def outcome(payload):
    pricing = importlib.import_module("pricing")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            order = pricing.parse_order(copy.deepcopy(payload))
        except pricing.ContractError as error:
            return {"error": error.code}
    q = pricing.quote(order)
    return {"ok": {"source_version": order.source_version, "account_id": order.account_id, "account_tier": order.account_tier,
                   "currency": order.currency, "subtotal": q["subtotal"], "discount": q["discount"], "total": q["total"]}}


class HiddenVectors(unittest.TestCase):
    def test_vectors(self):
        for case in VECTORS:
            with self.subTest(case=case["name"]):
                got = outcome(case["payload"])
                if "error" in case["expect"]:
                    self.assertEqual(got, case["expect"])
                else:
                    self.assertIn("ok", got)
                    self.assertEqual({k: got["ok"][k] for k in case["expect"]["ok"]}, case["expect"]["ok"])


class HiddenOwnConformance(unittest.TestCase):
    def test_cases_files(self):
        main = CONFORMANCE / "cases.json"
        compat = CONFORMANCE / "cases-compat-v1.json"
        self.assertTrue(main.exists(), "shared/contracts/conformance/cases.json is missing")
        self.assertTrue(compat.exists(), "shared/contracts/conformance/cases-compat-v1.json is missing")
        cases = json.loads(main.read_text(encoding="utf-8"))
        legacy = json.loads(compat.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(cases), 15)
        self.assertGreaterEqual(len(legacy), 3)
        seen = set()
        for case in cases + legacy:
            self.assertEqual(set(case) >= {"name", "payload", "expect"}, True, case)
            expect = case["expect"]
            self.assertTrue(("error" in expect) != ("ok" in expect), case["name"])
            seen.add(expect.get("error", "ok"))
            # the cases must be true for the reference reader too
            got = outcome(case["payload"])
            if "error" in expect:
                self.assertEqual(got, expect, case["name"])
            else:
                # Later contract versions add fields this reader does not
                # project (p3's settlement fields): compare the ones it knows.
                known = {k: v for k, v in expect["ok"].items() if k in got["ok"]}
                self.assertTrue(known, case["name"])
                self.assertEqual({k: got["ok"][k] for k in known}, known, case["name"])
        self.assertTrue({"ok", "INVALID", "MIXED_FIELDS", "UNSUPPORTED_VERSION"} <= seen, seen)
        self.assertNotIn("customer", main.read_text(encoding="utf-8"))

    def test_own_suites_exist(self):
        for rel in ("services/pricing-py/tests/test_conformance.py", "services/web-js/test/conformance.test.js", "services/ledger-go/ledger/conformance_test.go"):
            path = ROOT / rel
            self.assertTrue(path.exists(), "%s is missing" % rel)
            self.assertIn("conformance", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
