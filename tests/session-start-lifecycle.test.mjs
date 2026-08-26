import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { registerSessionStartHook } from "../packages/piagent-core/runtime/hooks/session-start-hook.ts";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("piagent-session-start-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function harness({ invalidateDuringIndex = false, invalidateDuringAfterStart = false, afterStartError } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-start-"));
  temporaryRoots.add(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  let active = true;
  let activeToolReads = 0;
  let afterStartCalls = 0;
  const telemetry = [];
  const notices = [];
  const assertActive = () => {
    if (!active) throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  const sessionManager = {
    getSessionId() { assertActive(); return "session-start-test"; },
    getSessionName() { assertActive(); return "operator named session"; },
    getSessionFile() { assertActive(); return path.join(cwd, "session.jsonl"); },
    getEntries() { assertActive(); return []; },
    getBranch() { assertActive(); return []; }
  };
  const ctx = {
    get cwd() { assertActive(); return cwd; },
    get mode() { assertActive(); return "print"; },
    get model() { assertActive(); return { provider: "test", id: "model" }; },
    get sessionManager() { assertActive(); return sessionManager; },
    get ui() {
      assertActive();
      return { notify(message, level) { assertActive(); notices.push({ message, level }); } };
    },
    isProjectTrusted() { assertActive(); return true; },
    getContextUsage() { assertActive(); return { tokens: 0, contextWindow: 1_000, percent: 0 }; }
  };
  const handlers = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    setSessionName() { assertActive(); },
    getThinkingLevel() { assertActive(); return "high"; },
    getActiveTools() {
      assertActive();
      activeToolReads += 1;
      return ["read", "grep", "find", "ls"];
    }
  };
  registerSessionStartHook(pi, {
    state: {
      clearSession() {},
      clearDigestMigrationState() {},
      cacheTaskIdentity() {},
      rememberResumeState() {}
    },
    loadProfile: () => ({ displayName: "Fixture", projectId: "fixture" }),
    projectProfileExists: () => true,
    activateToolGroups: () => [],
    taskReference: () => undefined,
    activeTask: () => undefined,
    resolveTask: () => undefined,
    resolveTaskAny: () => undefined,
    bindTask: () => undefined,
    writeTask: (_cwd, task) => task,
    appendTrace: () => undefined,
    capabilityState: () => ({ ok: true }),
    permissionProfile: () => ({ mode: "read-only" }),
    legacyProjectWarning: () => undefined,
    mcpReadinessNotice: () => undefined,
    updateAvailabilityNotice: () => undefined,
    contextExcludePatterns: () => {
      if (invalidateDuringIndex) queueMicrotask(() => { active = false; });
      return [];
    },
    inspectResume: () => { throw new Error("no task should be resumed"); },
    telemetry: (_ctx, payload) => { assertActive(); telemetry.push(payload); },
    afterStart: async () => {
      assertActive();
      afterStartCalls += 1;
      if (invalidateDuringAfterStart) {
        await Promise.resolve();
        active = false;
        assertActive();
      }
      if (afterStartError) throw new Error(afterStartError);
    }
  });
  return {
    ctx,
    start: () => handlers.get("session_start")({}, ctx),
    telemetry,
    notices,
    activeToolReads: () => activeToolReads,
    afterStartCalls: () => afterStartCalls
  };
}

describe("session-start replacement lifecycle", () => {
  it("stops the outgoing hook quietly when its context is replaced during index I/O", async () => {
    const test = harness({ invalidateDuringIndex: true });
    await assert.doesNotReject(test.start());
    assert.equal(test.activeToolReads(), 1, "active tools must be captured before the first await");
    assert.equal(test.telemetry.length, 0, "the outgoing session must not publish startup telemetry");
    assert.equal(test.afterStartCalls(), 0, "the outgoing session must not bind post-start surfaces");
  });

  it("preserves startup telemetry and post-start binding for the current session", async () => {
    const test = harness();
    await test.start();
    assert.equal(test.activeToolReads(), 1);
    assert.equal(test.telemetry.length, 1);
    assert.equal(test.telemetry[0].event, "session_start");
    assert.equal(test.telemetry[0].activeTools, 4);
    assert.equal(test.telemetry[0].index.exists, false);
    assert.equal(test.afterStartCalls(), 1);
  });

  it("does not report a stale post-start continuation as a startup failure", async () => {
    const test = harness({ invalidateDuringAfterStart: true });
    await assert.doesNotReject(test.start());
    assert.equal(test.telemetry.length, 1);
    assert.equal(test.afterStartCalls(), 1);
  });

  it("still reports a genuine post-start failure on the current session", async () => {
    const test = harness({ afterStartError: "post-start failed" });
    await assert.rejects(test.start(), /post-start failed/);
  });
});
