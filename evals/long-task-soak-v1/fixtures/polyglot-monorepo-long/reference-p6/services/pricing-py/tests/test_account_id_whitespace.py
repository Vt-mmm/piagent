import unittest
import warnings

from helpers import sample
from pricing import ContractError, parse_order
from pricing.compat_v1 import LEGACY_FIELDS

LEGACY_ID = next(old for old, new in LEGACY_FIELDS.items() if new == "account_id")


class AccountIdWhitespaceTest(unittest.TestCase):
    def assertInvalid(self, data):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with self.assertRaises(ContractError) as caught:
                parse_order(data)
        self.assertEqual(caught.exception.code, "INVALID")

    def test_rejects_padded_ids(self):
        for bad in (" C-100", "C-100 ", "\tC-100", "C-100\n"):
            self.assertInvalid({**sample("order-basic.json"), "account_id": bad})
            self.assertInvalid({**sample("v3/order-fx-usd-vnd.json"), "account_id": bad})
            legacy = sample("order-compat-v1.json")
            legacy[LEGACY_ID] = bad
            self.assertInvalid(legacy)

    def test_inner_space_is_fine(self):
        self.assertEqual(parse_order({**sample("order-basic.json"), "account_id": "C 100"}).account_id, "C 100")


if __name__ == "__main__":
    unittest.main()
