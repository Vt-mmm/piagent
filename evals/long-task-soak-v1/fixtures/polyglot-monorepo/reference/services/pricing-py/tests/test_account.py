import unittest

from helpers import SERVICE
from pricing import Account, account_discount_rate, load_accounts


class AccountTest(unittest.TestCase):
    def test_discount_rate_per_tier(self):
        self.assertEqual(account_discount_rate("standard"), 0)
        self.assertEqual(account_discount_rate("gold"), 5)
        self.assertEqual(account_discount_rate("vip"), 10)

    def test_unknown_tier(self):
        with self.assertRaises(ValueError):
            account_discount_rate("platinum")

    def test_load_accounts(self):
        accounts = load_accounts(SERVICE / "fixtures" / "accounts.json")
        self.assertEqual(accounts["C-200"], Account("C-200", "Công ty TNHH Lá Xanh", "vip"))
        self.assertEqual(len(accounts), 3)


if __name__ == "__main__":
    unittest.main()
