# Hidden acceptance (p6): the member's mid-task rule — account_id with leading or
# trailing whitespace is INVALID in every payload version — plus release 3.0.0.
import copy
import importlib
import unittest
import warnings

V2 = {"contract_version": 2, "order_id": "O-1", "account_id": "A-1", "account_tier": "gold", "currency": "VND",
      "items": [{"sku": "S", "qty": 1, "unit_price": 100}]}
V3 = {"contract_version": 3, "order_id": "O-3", "account_id": "A-3", "account_tier": "vip", "currency": "USD",
      "settlement_currency": "VND", "fx_rate_ppm": 25000000, "items": [{"sku": "S", "qty": 2, "unit_price": 999}]}
V1 = {"contract_version": 1, "order_id": "O-0", "customer_id": "C-0", "customer_tier": "standard", "currency": "USD",
      "items": [{"sku": "S", "qty": 1, "unit_price": 5}]}
PADDED = (" A-1", "A-1 ", "  A-1  ", "\tA-1", "A-1\n")


def code(data):
    p = importlib.import_module("pricing")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            p.parse_order(copy.deepcopy(data))
        except p.ContractError as error:
            return error.code
    return None


class HiddenAccountIdWhitespace(unittest.TestCase):
    def test_padded_ids_are_invalid(self):
        for bad in PADDED:
            self.assertEqual(code({**V2, "account_id": bad}), "INVALID", repr(bad))
            self.assertEqual(code({**V3, "account_id": bad}), "INVALID", repr(bad))
            self.assertEqual(code({**V1, "customer_id": bad}), "INVALID", repr(bad))
            legacy = {k: v for k, v in V1.items() if k != "contract_version"}
            self.assertEqual(code({**legacy, "customer_id": bad}), "INVALID", repr(bad))

    def test_clean_ids_still_read(self):
        for good in ("A-1", "A 1", "Đ-1"):
            self.assertIsNone(code({**V2, "account_id": good}), good)
            self.assertIsNone(code({**V3, "account_id": good}), good)

    def test_other_codes_win_first(self):
        self.assertEqual(code({**V2, "account_id": " A-1", "contract_version": 9}), "UNSUPPORTED_VERSION")
        self.assertEqual(code({**V2, "account_id": " A-1", "customer_id": "C"}), "MIXED_FIELDS")


class HiddenRelease(unittest.TestCase):
    def test_version(self):
        self.assertEqual(importlib.import_module("pricing").__version__, "3.0.0")


if __name__ == "__main__":
    unittest.main()
