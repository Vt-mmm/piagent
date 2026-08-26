import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RetrievalEvidenceRuntime
} from "../packages/piagent-core/runtime/session/retrieval-evidence-runtime.ts";

function context(sessionId = "session-a") {
  return {
    cwd: "/workspace/project",
    sessionManager: { getSessionId: () => sessionId }
  };
}

function observation(index, overrides = {}) {
  return {
    toolName: "read",
    callFingerprint: `call-${index}`,
    outputHash: `output-${index}`,
    target: `src/${index}.ts`,
    ...overrides
  };
}

describe("retrieval evidence runtime", () => {
  it("keeps new evidence available and emits a soft checkpoint instead of a hard search cap", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const ctx = context();
    runtime.beginTurn(ctx);
    for (let index = 1; index < 32; index += 1) {
      assert.equal(runtime.observe(ctx, observation(index)), undefined);
    }
    const checkpoint = runtime.observe(ctx, observation(32));
    assert.equal(checkpoint.reason, "evidence-checkpoint");
    assert.equal(checkpoint.calls, 32);
    assert.equal(checkpoint.uniqueCalls, 32);
    assert.equal(checkpoint.uniqueTargets, 32);
    assert.match(checkpoint.text, /Continue only for a named unresolved criterion/);

    // A new target remains usable after the checkpoint; the runtime advises but
    // never blocks model intelligence or repository coverage.
    assert.equal(runtime.observe(ctx, observation(33)), undefined);
  });

  it("does not merge distinct long targets that share a large prefix", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const ctx = context();
    const prefix = `src/${"nested/".repeat(100)}`;
    for (let index = 1; index <= 5; index += 1) {
      assert.equal(runtime.observe(ctx, observation(index, {
        outputHash: "same-empty-output",
        target: `${prefix}different-${index}.ts`
      })), undefined, "each confirmed long target remains distinct evidence");
    }
  });

  it("detects repeated/no-evidence loops early and resets novelty after mutation", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const ctx = context();
    runtime.beginTurn(ctx);
    assert.equal(runtime.observe(ctx, observation(1)), undefined);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(runtime.observe(ctx, observation(1)), undefined);
    }
    const saturated = runtime.observe(ctx, observation(1));
    assert.equal(saturated.reason, "evidence-saturated");
    assert.equal(saturated.noNovelEvidenceStreak, 4);
    assert.equal(saturated.repeatedCalls, 4);

    runtime.invalidateAfterMutation(ctx, "turn-one");
    assert.equal(runtime.observe(ctx, observation(1), "turn-one"), undefined,
      "a changed working tree makes an earlier exact read eligible as fresh evidence");
    for (let index = 2; index <= 5; index += 1) {
      const result = runtime.observe(ctx, observation(index, { deterministicMiss: true }), "turn-one");
      if (index < 5) assert.equal(result, undefined);
      else {
        assert.equal(result.reason, "evidence-saturated");
        assert.equal(result.calls, 10, "operation-wide call accounting survives mutation");
        assert.equal(result.generation, 1);
        assert.equal(result.generationCalls, 5);
        assert.equal(result.uniqueCalls, 5, "operation-wide uniqueness is not erased by mutation");
        assert.equal(result.repeatedCalls, 5, "historical duplicate accounting remains truthful");
      }
    }
  });

  it("treats distinct hard retrieval failures as no evidence without hiding or blocking them", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const ctx = context();
    runtime.beginTurn(ctx, "failure-turn");
    for (let index = 1; index <= 4; index += 1) {
      const checkpoint = runtime.observe(ctx, observation(index, { nonEvidenceFailure: true }), "failure-turn");
      if (index < 4) assert.equal(checkpoint, undefined);
      else {
        assert.equal(checkpoint.reason, "evidence-saturated");
        assert.equal(checkpoint.deterministicMisses, 0,
          "unknown failures are not mislabeled as deterministic negative evidence");
      }
    }
  });

  it("isolates operation/session state and counts deterministic misses as negative evidence", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const first = context("session-a"), second = context("session-b");
    runtime.beginTurn(first);
    runtime.beginTurn(second);
    for (let index = 1; index <= 4; index += 1) {
      const result = runtime.observe(first, observation(index, {
        callFingerprint: `missing-${index}`,
        outputHash: `missing-output-${index}`,
        deterministicMiss: true
      }));
      if (index < 4) assert.equal(result, undefined);
      else {
        assert.equal(result.reason, "evidence-saturated");
        assert.equal(result.deterministicMisses, 4);
      }
    }
    assert.equal(runtime.observe(second, observation(1)), undefined);

    runtime.beginTurn(first);
    assert.equal(runtime.observe(first, observation(1)), undefined,
      "a new user operation must not inherit negative-path saturation");
    runtime.clearSession(first);
    assert.equal(runtime.observe(first, observation(1, { deterministicMiss: true })), undefined,
      "session shutdown cleanup must discard the prior operation window");
  });

  it("automatically starts a fresh evidence window when the host turn identity changes", () => {
    const runtime = new RetrievalEvidenceRuntime();
    const ctx = context();
    for (let index = 1; index <= 4; index += 1) {
      const checkpoint = runtime.observe(ctx, observation(index, { deterministicMiss: true }), "turn-one");
      if (index === 4) assert.equal(checkpoint.reason, "evidence-saturated");
    }
    assert.equal(runtime.observe(ctx, observation(1), "turn-two"), undefined,
      "the next user operation must not inherit retrieval saturation or call identity");
    runtime.invalidateAfterMutation(ctx, "turn-two");
    runtime.beginTurn(ctx, "turn-three");
    for (let index = 1; index <= 4; index += 1) {
      const checkpoint = runtime.observe(ctx, observation(index, { deterministicMiss: true }), "turn-three");
      if (index === 4) assert.equal(checkpoint.generation, 0,
        "working-tree generation belongs to one operator turn and resets with it");
    }
  });
});
