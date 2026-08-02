import assert from "node:assert/strict";
import test from "node:test";
import { isSessionValid } from "../src/auth/session.js";

test("accepts a future expiry", () => {
  assert.equal(isSessionValid({ expiresAt: 101 }, 100), true);
});
