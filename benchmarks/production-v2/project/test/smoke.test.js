import assert from "node:assert/strict";
import test from "node:test";

import { pageCount } from "../src/frontend/pagination.js";
import { migrateSettings } from "../src/data/migration.js";
import { isExpired } from "../src/reliability/expiry.js";

test("public API smoke checks", () => {
  assert.equal(pageCount(1, 20), 1);
  assert.equal(migrateSettings({}).version, 2);
  assert.equal(isExpired("2099-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z")), false);
  for (const value of [
    "2026-01-01T00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.999Z",
    "2026-01-01T07:00:00+07:00",
    "2026-01-01T07:00:00.999+07:00",
    "0000-02-29T00:00:00Z",
    "0099-12-31T23:59:59Z"
  ]) assert.equal(isExpired(value, Date.parse(value) + 1), true, value);
});
