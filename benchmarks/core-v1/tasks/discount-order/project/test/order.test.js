import assert from "node:assert/strict";
import test from "node:test";
import { orderTotal } from "../src/order.js";

test("keeps a zero-percent order unchanged", () => {
  assert.equal(orderTotal([{ price: 10, quantity: 2 }], 0), 20);
});
