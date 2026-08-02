import assert from "node:assert/strict";
import test from "node:test";

import { pageCount } from "../src/frontend/pagination.js";
import { migrateSettings } from "../src/data/migration.js";
import { isExpired } from "../src/reliability/expiry.js";

test("public API smoke checks", () => {
  assert.equal(pageCount(1, 20), 1);
  assert.equal(migrateSettings({}).version, 2);
  assert.equal(isExpired("2099-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z")), false);
});
