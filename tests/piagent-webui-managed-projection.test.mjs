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

// The end-of-turn review runs for many minutes with the main agent quiet: the
// page names it and says how long, instead of looking like a stuck turn.
test("running helpers carry their roles and start, only while they run", () => {
  const entry = (timestamp, data) => ({ type: "custom", customType: "agent-watch-helpers", timestamp, data });
  const started = [entry("2026-10-31T16:00:00.000Z", { active: 0, maximum: 4, roles: [] }), entry("2026-10-31T16:29:36.000Z", { active: 1, maximum: 4, roles: ["review"] })];
  assert.deepEqual(managedProjection(company, started).managedHelpers, { active: 1, maximum: 4, roles: ["review"], since: "2026-10-31T16:29:36.000Z" });
  const second = [...started, entry("2026-10-31T16:30:00.000Z", { active: 2, maximum: 4, roles: ["review", "verify"] })];
  assert.equal(managedProjection(company, second).managedHelpers.since, "2026-10-31T16:29:36.000Z");
  const ended = [...started, entry("2026-10-31T16:49:53.000Z", { active: 0, maximum: 4, roles: [] })];
  assert.deepEqual(managedProjection(company, ended).managedHelpers, { active: 0, maximum: 4 });
  assert.deepEqual(managedProjection(company, helpers({ active: 1, maximum: 4, roles: ["Bad Role", 7] })).managedHelpers.roles, undefined);
});
