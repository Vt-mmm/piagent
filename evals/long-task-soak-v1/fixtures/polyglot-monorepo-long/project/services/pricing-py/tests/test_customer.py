import unittest

from helpers import SERVICE
from pricing import Customer, customer_discount_rate, load_customers


class CustomerTest(unittest.TestCase):
    def test_discount_rate_per_tier(self):
        self.assertEqual(customer_discount_rate("standard"), 0)
        self.assertEqual(customer_discount_rate("gold"), 5)
        self.assertEqual(customer_discount_rate("vip"), 10)

    def test_unknown_tier(self):
        with self.assertRaises(ValueError):
            customer_discount_rate("platinum")

    def test_load_customers(self):
        customers = load_customers(SERVICE / "fixtures" / "customers.json")
        self.assertEqual(customers["C-200"], Customer("C-200", "Công ty TNHH Lá Xanh", "vip"))
        self.assertEqual(len(customers), 3)


if __name__ == "__main__":
    unittest.main()
