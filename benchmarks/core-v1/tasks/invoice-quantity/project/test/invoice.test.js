import assert from "node:assert/strict";
import test from "node:test";
import { invoiceTotal } from "../src/invoice.js";

test("adds one of each line", () => {
  assert.equal(invoiceTotal([{ price: 10, quantity: 1 }, { price: 5, quantity: 1 }]), 15);
});
