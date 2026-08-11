import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  SolverShadowRuntime,
  readSolverShadowEvents,
  solverModeFromEnvironment,
  solverShadowEventPath
} from "../packages/piagent-core/runtime/solver/solver-shadow.ts";

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-solver-shadow-"));
}

function input(request = "Implement src/a.ts", overrides = {}) {
  return {
    request,
    profileMode: "fullstack",
    projectShape: ["backend"],
    gitReady: true,
    dirtyTree: false,
    verifierReady: true,
    contextPressure: 0.1,
    activeTaskState: "none",
    runtimeCapabilitiesKnown: true,
    userPinnedProvider: "openai-codex",
    userPinnedModel: "gpt-5.6-terra",
    userPinnedEffort: "medium",
    ...overrides
  };
}

describe("solver shadow runtime", () => {
  it("defaults to shadow and accepts only the bounded mode vocabulary", () => {
    assert.equal(solverModeFromEnvironment(undefined), "shadow");
    assert.equal(solverModeFromEnvironment("recommend"), "recommend");
    assert.equal(solverModeFromEnvironment("off"), "off");
    assert.equal(solverModeFromEnvironment("surprise"), "shadow");
  });

  it("performs no extraction, solve, or persistence in off mode", () => {
    let calls = 0;
    const runtime = new SolverShadowRuntime("off", {
      extract: () => { calls += 1; throw new Error("must not run"); },
      solve: () => { calls += 1; throw new Error("must not run"); },
      persist: () => { calls += 1; throw new Error("must not run"); }
    });
    assert.deepEqual(runtime.evaluate(workspace(), "s1", input()), { status: "off", durationMs: 0 });
    assert.equal(calls, 0);
  });

  it("reuses identical session features and recomputes material changes", () => {
    const cwd = workspace();
    const runtime = new SolverShadowRuntime("shadow");
    const first = runtime.evaluate(cwd, "s1", input());
    const reused = runtime.evaluate(cwd, "s1", input());
    const changed = runtime.evaluate(cwd, "s1", input("Review src/a.ts"));
    assert.equal(first.status, "ok");
    assert.equal(first.reused, false);
    assert.equal(first.persisted, true);
    assert.equal(reused.status, "ok");
    assert.equal(reused.reused, true);
    assert.equal(changed.status, "ok");
    assert.equal(changed.reused, false);
    assert.notEqual(changed.features.featureHash, first.features.featureHash);
    assert.equal(readSolverShadowEvents(cwd).records.length, 2);
  });

  it("persists bounded redacted events without prompt or raw session identity", () => {
    const cwd = workspace();
    new SolverShadowRuntime("shadow").evaluate(cwd, "private-session-id", input("Implement src/a.ts", {
      userPinnedModel: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456"
    }));
    const file = solverShadowEventPath(cwd);
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /Implement src\/a|private-session-id|sk-proj-/);
    assert.match(text, /"userPinnedModel":"redacted"/);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.statSync(file).size < 512 * 1024);
  });

  it("routes corruption and unsafe paths to warnings without throwing", () => {
    const cwd = workspace();
    const file = solverShadowEventPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken\n");
    const result = new SolverShadowRuntime("shadow").evaluate(cwd, "s1", input());
    assert.equal(result.status, "ok");
    assert.equal(result.persisted, false);
    assert.ok(result.warnings.length > 0);

    const unsafe = workspace();
    fs.mkdirSync(path.join(unsafe, ".pi", "piagent-state"), { recursive: true });
    fs.symlinkSync(workspace(), path.join(unsafe, ".pi", "piagent-state", "solver"));
    const unsafeResult = new SolverShadowRuntime("shadow").evaluate(unsafe, "s1", input());
    assert.equal(unsafeResult.status, "ok");
    assert.equal(unsafeResult.persisted, false);
    assert.ok(unsafeResult.warnings.length > 0);
  });

  it("turns solver failures into observable errors", () => {
    const result = new SolverShadowRuntime("shadow", {
      extract: () => { throw new Error("synthetic solver failure"); }
    }).evaluate(workspace(), "s1", input());
    assert.equal(result.status, "error");
    assert.match(result.warnings.join(" "), /synthetic solver failure/);
  });

  it("records only an observed later route that differs", () => {
    const cwd = workspace();
    const runtime = new SolverShadowRuntime("shadow");
    const evaluated = runtime.evaluate(cwd, "s1", input());
    assert.equal(evaluated.status, "ok");
    assert.equal(runtime.observeRoute(cwd, "s1", evaluated.decision.route).status, "same-route");
    assert.equal(readSolverShadowEvents(cwd).records.length, 1);
    const captured = runtime.observeRoute(cwd, "s1", "plan-first", "2026-08-08T00:00:00.000Z");
    assert.equal(captured.status, "recorded");
    assert.deepEqual(captured.decision.override, { observed: true, route: "plan-first", recordedAt: "2026-08-08T00:00:00.000Z" });
    assert.equal(readSolverShadowEvents(cwd).records.length, 2);
  });

  it("contains no host mutation or helper-spawn calls", () => {
    const sources = ["solver-shadow.ts", "solver-policy.ts", "task-features.ts"]
      .map((name) => fs.readFileSync(path.join(process.cwd(), "packages/piagent-core/runtime/solver", name), "utf8"))
      .join("\n");
    assert.doesNotMatch(sources, /setActiveTools|setModel|setThinkingLevel|spawnAgent|create_thread/);
  });
});
