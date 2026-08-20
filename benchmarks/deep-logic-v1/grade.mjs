import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
const oracle = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const scenario = process.env.PIAGENT_BENCHMARK_SCENARIO;
const data = oracle.graderData;
const checks = [];
async function check(id, action) { try { await action(); checks.push({ id, passed: true }); } catch { checks.push({ id, passed: false }); } }
async function load(file) { const url = pathToFileURL(path.join(workspace, file)); url.searchParams.set("benchmark", `${Date.now()}-${Math.random()}`); return import(url.href); }

switch (scenario) {
  case "revision-event-reconciliation": {
    const { reconcileSession } = await load("src/event-reconcile.js");
    await check("contiguous-revision-application", () => {
      const snapshot = { revision: data.revisions[0], nextSequence: data.start, state: { keep: true, remove: "old" } };
      const first = { id: "a", sequence: data.start, baseRevision: data.revisions[0], revision: data.revisions[1], patch: { [data.key]: 1, remove: null } };
      const second = { id: "b", sequence: data.start + 1, baseRevision: data.revisions[1], revision: data.revisions[2], patch: { [data.key]: 2 } };
      const inputs = structuredClone([snapshot, [second, first, structuredClone(first)]]);
      const result = reconcileSession(snapshot, [second, first, structuredClone(first)]);
      assert.deepEqual(result, { revision: data.revisions[2], nextSequence: data.start + 2, state: { keep: true, [data.key]: 2 },
        appliedIds: ["a", "b"], duplicateIds: ["a"], pending: [], gap: null });
      assert.deepEqual([snapshot, [second, first, structuredClone(first)]], inputs);
    });
    await check("gap-and-conflict-fail-closed", () => {
      const snapshot = { revision: "r0", nextSequence: 4, state: {} };
      const late = { id: "late", sequence: 6, baseRevision: "r1", revision: "r2", patch: {} };
      assert.deepEqual(reconcileSession(snapshot, [late]).gap, { expected: 4, observed: 6 });
      assert.throws(() => reconcileSession(snapshot, [
        { id: "x", sequence: 4, baseRevision: "r0", revision: "r1", patch: {} },
        { id: "y", sequence: 4, baseRevision: "r0", revision: "r2", patch: {} }
      ]));
      assert.throws(() => reconcileSession(snapshot, [{ id: "x", sequence: 4, baseRevision: "wrong", revision: "r1", patch: {} }]));
      assert.throws(() => reconcileSession(snapshot, [{ id: "x", sequence: 4, baseRevision: "r0", revision: "r1", patch: JSON.parse('{"__proto__":1}') }]));
    });
    break;
  }
  case "fair-dependency-scheduler": {
    const { scheduleJobs } = await load("src/scheduler.js");
    await check("dependency-capacity-fairness", () => {
      const [a, b, c] = data.tenants, cap = data.capacity;
      const jobs = [
        { id: "a1", tenant: a, weight: 1, dependsOn: [] }, { id: "a2", tenant: a, weight: 1, dependsOn: [] },
        { id: "b1", tenant: b, weight: 1, dependsOn: [] }, { id: "c1", tenant: c, weight: 1, dependsOn: [] },
        { id: "after", tenant: a, weight: Math.min(2, cap), dependsOn: ["b1", "c1"] }
      ];
      const before = structuredClone(jobs), waves = scheduleJobs(jobs, cap);
      assert.deepEqual(jobs, before);
      assert.equal(new Set(waves.flat()).size, jobs.length);
      assert.deepEqual(new Set(waves[0].slice(0, 3)), new Set(["a1", "b1", "c1"]));
      const waveOf = new Map(waves.flatMap((wave, index) => wave.map((id) => [id, index])));
      assert.ok(waveOf.get("after") > waveOf.get("b1") && waveOf.get("after") > waveOf.get("c1"));
      for (const wave of waves) assert.ok(wave.reduce((sum, id) => sum + jobs.find((job) => job.id === id).weight, 0) <= cap);
    });
    await check("invalid-graph-rejected", () => {
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 1, dependsOn: ["b"] }], 2));
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 1, dependsOn: ["b"] }, { id: "b", tenant: "t", weight: 1, dependsOn: ["a"] }], 2));
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 3, dependsOn: [] }], 2));
    });
    break;
  }
  case "layered-policy-resolution": {
    const { decideAccess } = await load("src/policy.js");
    await check("precedence-and-protected-deny", () => {
      const layers = [
        { name: "global", rules: [{ pattern: "src/**", operations: [data.operation], effect: "allow" },
          { pattern: "src/**", operations: [data.operation], effect: "deny" },
          { pattern: "private/**", operations: ["*"], effect: "deny", protected: true }] },
        { name: "project", rules: [{ pattern: "src/**", operations: [data.operation], effect: "allow" }] }
      ];
      assert.equal(decideAccess({ path: "src/a/config.json", operation: data.operation }, layers).allowed, true);
      const denied = decideAccess({ path: data.protectedPath, operation: data.operation }, layers);
      assert.equal(denied.allowed, false); assert.equal(denied.protected, true); assert.equal(denied.layer, "global");
      assert.equal(decideAccess({ path: "docs/readme.md", operation: data.operation }, layers).allowed, false);
    });
    await check("path-and-rule-validation", () => {
      const allow = [{ name: "x", rules: [{ pattern: "**", operations: ["*"], effect: "allow" }] }];
      for (const unsafe of ["../secret", "/root", "a\\b", "a//b", "./a", "a/../b"]) assert.throws(() => decideAccess({ path: unsafe, operation: "read" }, allow));
      assert.throws(() => decideAccess({ path: "a", operation: "read" }, [{ name: "x", rules: [{ pattern: "[a]", operations: ["read"], effect: "allow" }] }]));
    });
    break;
  }
  case "budgeted-context-graph": {
    const { buildContextPack } = await load("src/context-pack.js");
    await check("ranking-propagation-budget", () => {
      const nodes = [
        { id: "guide", path: "docs/guide.md", text: `${data.term} architecture`, tokens: 3 },
        { id: "impl", path: "src/impl.js", text: "implementation details", tokens: 4 },
        { id: "required", path: "AGENTS.md", text: "rules", tokens: 2, required: true },
        { id: "large", path: "src/large.js", text: data.term, tokens: data.budget + 1 }
      ];
      const before = structuredClone(nodes), result = buildContextPack(data.term, nodes, [{ from: "guide", to: "impl", weight: 1 }], data.budget);
      assert.deepEqual(nodes, before);
      assert.deepEqual(result.selected.map((item) => item.id).slice(0, 3), ["required", "guide", "impl"]);
      assert.ok(result.usedTokens <= data.budget); assert.equal(result.confidence, "high");
      assert.equal(result.selected.find((item) => item.id === "impl").score, 0.5);
      assert.ok(result.omitted.some((item) => item.id === "large"));
    });
    await check("graph-validation-and-required-budget", () => {
      assert.throws(() => buildContextPack("x", [{ id: "a", path: "a", text: "x", tokens: 5, required: true }], [], 4));
      assert.throws(() => buildContextPack("x", [{ id: "a", path: "a", text: "x", tokens: 1 }], [{ from: "a", to: "missing", weight: 1 }], 4));
      const result = buildContextPack("Đặng", [{ id: "a", path: "a", text: "đặng", tokens: 1 }], [], 1);
      assert.equal(result.selected[0].directScore, 1);
    });
    break;
  }
  case "resumable-stream-assembly": {
    const { assembleStream } = await load("src/stream.js");
    await check("interleaved-replay-and-gap", () => {
      const snapshot = { cursor: 2, messages: [{ id: data.message, text: data.first, complete: false }] };
      const events = [
        { cursor: 5, messageId: "other", offset: 0, text: "late", complete: false },
        { cursor: 1, messageId: data.message, offset: 0, text: "old", complete: false },
        { cursor: 3, messageId: data.message, offset: data.first.length, text: data.second, complete: true }
      ];
      const before = structuredClone([snapshot, events]), result = assembleStream(snapshot, events);
      assert.deepEqual([snapshot, events], before);
      assert.equal(result.cursor, 3); assert.equal(result.messages[0].text, data.first + data.second); assert.equal(result.messages[0].complete, true);
      assert.deepEqual(result.appliedCursors, [3]); assert.deepEqual(result.replayedCursors, [1]);
      assert.deepEqual(result.gap, { expected: 4, observed: 5 }); assert.equal(result.buffered[0].cursor, 5);
    });
    await check("offset-completion-and-cursor-conflicts", () => {
      const base = { cursor: 0, messages: [] };
      assert.throws(() => assembleStream(base, [{ cursor: 1, messageId: "m", offset: 1, text: "x", complete: false }]));
      assert.throws(() => assembleStream(base, [
        { cursor: 1, messageId: "m", offset: 0, text: "x", complete: false },
        { cursor: 1, messageId: "m", offset: 0, text: "y", complete: false }
      ]));
      assert.throws(() => assembleStream({ cursor: 0, messages: [{ id: "m", text: "x", complete: true }] },
        [{ cursor: 1, messageId: "m", offset: 1, text: "", complete: true }]));
    });
    break;
  }
  case "transactional-config-merge": {
    const { planConfigTransaction } = await load("src/config-transaction.js");
    await check("merge-delete-default-audit-digest", () => {
      const base = { service: { port: 3000, stale: true }, remove: "x" };
      const layers = [{ service: { port: 0, [data.key]: data.value }, remove: { $delete: true } }];
      const schema = { service: { type: "object", required: true }, remove: { type: "string" }, enabled: { type: "boolean", default: false } };
      const before = structuredClone([base, layers, schema]), result = planConfigTransaction(base, layers, schema);
      assert.deepEqual([base, layers, schema], before);
      assert.deepEqual(result.next, { service: { port: 0, stale: true, [data.key]: data.value }, enabled: false });
      assert.deepEqual(result.changes.map((item) => item.path), [...result.changes.map((item) => item.path)].sort());
      assert.ok(result.changes.some((item) => item.path === "/remove" && item.kind === "delete"));
      assert.ok(result.changes.some((item) => item.path === "/enabled" && item.kind === "add"));
      assert.match(result.digest, /^[a-f0-9]{64}$/);
      const canonical = JSON.stringify({ enabled: false, service: { [data.key]: data.value, port: 0, stale: true } });
      assert.equal(result.digest, crypto.createHash("sha256").update(canonical).digest("hex"));
    });
    await check("schema-and-pollution-fail-closed", () => {
      assert.throws(() => planConfigTransaction({}, [{ unknown: true }], { known: { type: "boolean" } }));
      assert.throws(() => planConfigTransaction({}, [{}], { required: { type: "string", required: true } }));
      assert.throws(() => planConfigTransaction({}, [{ x: { $delete: false } }], { x: { type: "object" } }));
      assert.throws(() => planConfigTransaction(JSON.parse('{"__proto__":1}'), [], {}));
    });
    break;
  }
  default: throw new Error(`unsupported deep logic scenario ${scenario}`);
}

const passed = checks.length > 0 && checks.every((item) => item.passed);
process.stdout.write(`${JSON.stringify({ passed, score: passed ? 10 : 0, checks })}\n`);
