import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentStatusFiles, statusOf, statusFileName } from "../packages/piagent-webui/gateway/agent-status-files.ts";

// Each conversation's state for Agent Watch: working, waiting on the member
// (an approval or a question), done, stopped or failed; one file per
// conversation, never its preview, written only when it changes and removed
// when the conversation is gone, archived or a day old.
const row = (patch = {}) => ({ sessionRef: "session_a", title: "Fix refunds", projectLabel: "shop", state: "gateway-owned", liveState: "idle", archived: false,
  needsAttention: false, updatedAt: new Date().toISOString(), preview: "SECRET PROMPT TEXT", managedHelpers: { active: 0, maximum: 4 }, managedProcess: null, ...patch });
const at = new Date("2026-10-20T01:00:00Z");

test("states and their changes", () => {
  const idle = statusOf(row(), undefined, false, at);
  assert.equal(idle.state, "idle");
  const working = statusOf(row({ liveState: "running", managedHelpers: { active: 2, maximum: 4 } }), idle, false, at);
  assert.deepEqual([working.state, working.helpers], ["working", 2]);
  const approval = statusOf(row({ liveState: "waiting-approval" }), working, false, at);
  assert.deepEqual([approval.state, approval.kind], ["blocked", "permission"]);
  const question = statusOf(row({ liveState: "running", needsAttention: true }), approval, false, at);
  assert.deepEqual([question.state, question.kind], ["blocked", "question"]);
  const done = statusOf(row(), question, false, at);
  assert.deepEqual([done.state, done.ended], ["done", "done"]);
  assert.deepEqual([statusOf(row(), done, false, at).state, statusOf(row(), done, false, at).ended], ["done", "done"], "stays done until the next turn");
  const stopped = statusOf(row({ managedProcess: { outcome: "interrupted" } }), working, true, at);
  assert.deepEqual([stopped.ended, stopped.company], ["stopped", true]);
  assert.deepEqual([statusOf(row({ state: "recovery-required" }), working, false, at).state, statusOf(row({ state: "recovery-required" }), working, false, at).ended], ["error", "failed"]);
  const later = new Date(at.getTime() + 60_000);
  assert.equal(statusOf(row({ liveState: "running" }), working, false, later).since, working.since, "since is when the state began");
  assert.ok(!JSON.stringify(done).includes("SECRET"), "never the preview");
});

test("files: written on change, removed when gone, archived or old; a catalog that fails leaves them", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sessions = [row({ liveState: "running" }), row({ sessionRef: "session_b", title: "Old", updatedAt: "2026-01-01T00:00:00Z" })], fail = false;
  const files = new AgentStatusFiles(dir, async () => { if (fail) throw new Error("not ready"); return { sessions }; });
  await files.publish();
  const a = path.join(dir, statusFileName("session_a"));
  assert.deepEqual(fs.readdirSync(dir), [statusFileName("session_a")], "a day-old conversation gets no file");
  assert.equal(JSON.parse(fs.readFileSync(a, "utf8")).state, "working");
  assert.equal(fs.statSync(a).mode & 0o777, 0o600);
  const written = fs.statSync(a).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await files.publish();
  assert.equal(fs.statSync(a).mtimeMs, written, "unchanged state: not rewritten");
  sessions = [row({ liveState: "waiting-approval" })];
  await files.publish();
  assert.equal(JSON.parse(fs.readFileSync(a, "utf8")).kind, "permission");
  fail = true; await files.publish();
  assert.ok(fs.existsSync(a), "a failed read removes nothing");
  fail = false; sessions = [row({ archived: true })];
  await files.publish();
  assert.deepEqual(fs.readdirSync(dir), []);
});
