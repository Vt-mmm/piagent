import copy
import unittest
import warnings

from helpers import sample
from pricing import ContractError, parse_order, quote, upgrade_v1


class CompatV1Test(unittest.TestCase):
    def test_upgrade_v1_renames_fields_without_touching_input(self):
        legacy = sample("order-compat-v1.json")
        before = copy.deepcopy(legacy)
        upgraded = upgrade_v1(legacy)
        self.assertEqual(legacy, before)
        self.assertEqual(upgraded["contract_version"], 2)
        self.assertEqual(upgraded["account_id"], before["customer_id"])
        self.assertEqual(upgraded["account_tier"], before["customer_tier"])
        self.assertNotIn("customer_id", upgraded)

    def test_parse_v1_warns_and_reads_as_v2(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            order = parse_order(sample("order-compat-v1.json"))
        self.assertTrue(any(issubclass(w.category, DeprecationWarning) for w in caught))
        self.assertEqual(order.source_version, 1)
        self.assertEqual(order.to_dict(), sample("order-basic.json"))
        self.assertEqual(quote(order)["account_id"], "C-100")

    def test_v1_without_version_key(self):
        legacy = sample("order-compat-v1.json")
        del legacy["contract_version"]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.assertEqual(parse_order(legacy).source_version, 1)

    def test_mixed_fields(self):
        v2 = sample("order-basic.json")
        v2["customer_id"] = "C-1"
        legacy = sample("order-compat-v1.json")
        legacy["account_tier"] = "gold"
        for data in (v2, legacy):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with self.assertRaises(ContractError) as caught:
                    parse_order(data)
            self.assertEqual(caught.exception.code, "MIXED_FIELDS")


if __name__ == "__main__":
    unittest.main()
