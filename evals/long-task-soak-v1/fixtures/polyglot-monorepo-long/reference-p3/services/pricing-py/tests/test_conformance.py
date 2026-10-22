"""Shared contract conformance: every case in shared/contracts/conformance/*.json."""
import json
import unittest
import warnings

from helpers import ROOT
from pricing import ContractError, parse_order, quote, settlement_total

CONFORMANCE = ROOT / "shared" / "contracts" / "conformance"


def outcome(payload):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            order = parse_order(payload)
        except ContractError as error:
            return {"error": error.code}
    q = quote(order)
    return {"ok": {"source_version": order.source_version, "account_id": order.account_id, "account_tier": order.account_tier,
                   "currency": order.currency, "subtotal": q["subtotal"], "discount": q["discount"], "total": q["total"],
                   "settlement_currency": order.settlement_currency, "fx_rate_ppm": order.fx_rate_ppm, "settlement_total": settlement_total(order)}}


class ConformanceTest(unittest.TestCase):
    def test_every_case(self):
        files = sorted(CONFORMANCE.glob("*.json"))
        self.assertTrue(files)
        for path in files:
            for case in json.loads(path.read_text(encoding="utf-8")):
                with self.subTest(file=path.name, case=case["name"]):
                    got = outcome(case["payload"])
                    if "error" in case["expect"]:
                        self.assertEqual(got, case["expect"])
                    else:
                        self.assertIn("ok", got)
                        self.assertEqual({k: got["ok"][k] for k in case["expect"]["ok"]}, case["expect"]["ok"])


if __name__ == "__main__":
    unittest.main()
