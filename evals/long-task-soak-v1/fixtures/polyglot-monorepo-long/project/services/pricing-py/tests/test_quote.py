import unittest

from helpers import sample
from pricing import parse_order, quote


class QuoteTest(unittest.TestCase):
    def test_standard_has_no_discount(self):
        result = quote(parse_order(sample("order-basic.json")))
        self.assertEqual(result, {
            "order_id": "O-1001", "customer_id": "C-100", "currency": "VND",
            "subtotal": 210000, "discount": 0, "total": 210000,
        })

    def test_vip_gets_ten_percent(self):
        result = quote(parse_order(sample("order-vip.json")))
        self.assertEqual((result["subtotal"], result["discount"], result["total"]), (450000, 45000, 405000))

    def test_gold_discount_rounds_down(self):
        result = quote(parse_order(sample("order-gold.json")))
        self.assertEqual((result["subtotal"], result["discount"], result["total"]), (4596, 229, 4367))


if __name__ == "__main__":
    unittest.main()
