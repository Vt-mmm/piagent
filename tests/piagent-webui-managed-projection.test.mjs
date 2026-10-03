import assert from "node:assert/strict";
import test from "node:test";

import { managedProjection } from "../packages/piagent-webui/gateway/managed-projection.ts";

const company = { model: { provider: "agent_watch_managed" } };
const helpers = (data) => [{ type: "custom", customType: "agent-watch-helpers", data }];

// The dashboard shows running helpers against the number the company Harness
// enables (up to four), not a fixed two.
test("the managed helper count carries the Harness maximum", () => {
  assert.deepEqual(managedProjection(company, helpers({ active: 3, maximum: 4 })).managedHelpers, { active: 3, maximum: 4 });
  assert.deepEqual(managedProjection(company, helpers({ active: 0, maximum: 0 })).managedHelpers, { active: 0, maximum: 0 });
  // Recorded before the maximum was known: two helpers.
  assert.deepEqual(managedProjection(company, helpers({ active: 1 })).managedHelpers, { active: 1, maximum: 2 });
  // Out of range values never reach the page.
  assert.deepEqual(managedProjection(company, helpers({ active: 5, maximum: 4 })).managedHelpers, { active: 0, maximum: 4 });
  assert.deepEqual(managedProjection(company, helpers({ active: 1, maximum: 9 })).managedHelpers, { active: 1, maximum: 2 });
  assert.deepEqual(managedProjection({ model: { provider: "openai-codex" } }, helpers({ active: 1, maximum: 4 })), {});
});
