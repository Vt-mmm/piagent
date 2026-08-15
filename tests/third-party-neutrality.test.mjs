import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectThirdPartyNeutrality } from "../scripts/check-third-party-neutrality.mjs";

test("active WebUI plans and client language remain third-party neutral", () => {
  const result = inspectThirdPartyNeutrality();
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(result.checkedFiles > 20);
});
