import unittest

from helpers import sample
from pricing import ContractError, parse_order


class OrderTest(unittest.TestCase):
    def test_parse_basic_sample(self):
        order = parse_order(sample("order-basic.json"))
        self.assertEqual(order.order_id, "O-1001")
        self.assertEqual(order.customer_id, "C-100")
        self.assertEqual(order.customer_tier, "standard")
        self.assertEqual([i.sku for i in order.items], ["TEA-01", "CUP-02"])

    def test_round_trip(self):
        data = sample("order-gold.json")
        self.assertEqual(parse_order(data).to_dict(), data)

    def test_rejects_unknown_version(self):
        data = sample("order-basic.json")
        data["contract_version"] = 9
        with self.assertRaises(ContractError) as caught:
            parse_order(data)
        self.assertEqual(caught.exception.code, "UNSUPPORTED_VERSION")

    def test_rejects_bad_items(self):
        for items in ([], [{"sku": "A", "qty": 0, "unit_price": 1}], [{"sku": "A", "qty": True, "unit_price": 1}]):
            data = sample("order-basic.json")
            data["items"] = items
            with self.assertRaises(ContractError) as caught:
                parse_order(data)
            self.assertEqual(caught.exception.code, "INVALID")

    def test_rejects_unknown_tier(self):
        data = sample("order-basic.json")
        data["customer_tier"] = "platinum"
        with self.assertRaises(ContractError):
            parse_order(data)


if __name__ == "__main__":
    unittest.main()
