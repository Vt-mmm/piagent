import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runIndependentContract, compileIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { captureExecutionSnapshot, runSnapshotBoundContract } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { executionSourceText, validateModulePaths } from "../packages/piagent-core/extensions/acceptance-executor/module-graph.mjs";
import { data } from "../evals/harness-next/development-corpus.mjs";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const returns = (value) => ({ outcome: "return", value: data(value) });
const one = (expected) => [{ id: "one", args: [], expected: returns(expected) }];
const makePlan = (source, dependencies = [], cases = one(5)) => ({ schemaVersion: 1, source, exportName: "run",
  moduleGraph: { entry: "src/main.js", dependencies }, checks: [{ id: "behavior", cases }] });
const execute = (plan) => runIndependentContract({ planText: JSON.stringify(plan), imageId, dockerSocket });
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

test("module inputs have one explicit bounded identity and contain no expected answers", () => {
  const plan = makePlan("export const run=()=>5", [{ path: "src/b.js", source: "export const b=2" }, { path: "a.js", source: "export const a=1" }]);
  const request = JSON.parse(compileIndependentContract(JSON.stringify(plan)).requestText);
  assert.ok(request.cases.every((item) => !Object.hasOwn(item, "expected")));
  const digest = hash(executionSourceText(request));
  assert.equal(hash(executionSourceText({ ...request, moduleGraph: { ...request.moduleGraph, dependencies: [...request.moduleGraph.dependencies].reverse() } })), digest);
  const changed = structuredClone(request); changed.moduleGraph.dependencies[0].source += ";export const c=3";
  assert.notEqual(hash(executionSourceText(changed)), digest);
  for (const paths of [["src/main.js"], ["a.js", "a.js"], ["../a.js"], ["a/../b.js"], ["/a.js"], ["node:fs"],
    [".git/config"], ["node_modules/x.js"], ["a.js?x"], ["a%2f.js"], ["a.js#x"], Array(1), Array.from({ length: 32 }, (_, i) => `${i}.js`)]) {
    assert.throws(() => validateModulePaths("src/main.js", paths));
  }
  for (const dependencies of [[{ path: "a.js", source: "x".repeat(128 * 1024) }], [{ path: "a.js", source: "", expected: true }]]) {
    assert.throws(() => compileIndependentContract(JSON.stringify(makePlan("export const run=()=>5", dependencies))));
  }
});

test("actual transitive imports, default/named exports and re-exports execute supplied bytes", integration, async () => {
  const result = await execute(makePlan("import {value} from './lib/public.js'; export const run=()=>value();", [
    { path: "src/lib/public.js", source: "export {default as value} from '../../shared/math.js';" },
    { path: "shared/math.js", source: "const a=2,b=3; export default function value(){return a+b}" }
  ]));
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.execution.cleanupConfirmed, true);
});

test("actual module instances, live cyclic bindings and full-graph reset follow explicit histories", integration, async () => {
  const plan = makePlan(`import {inc, value} from './state.js'; import * as same from './lib/../state.js';
    export const twice=x=>x*2; export const run=()=>[inc(),same.value,value];`, [
    { path: "src/state.js", source: "import {twice} from './main.js'; export let value=0; export const inc=()=>{value+=1;return twice(value)};" }
  ], [
    { id: "first", sequence: "state", args: [], expected: returns([2, 1, 1]) },
    { id: "next", sequence: "state", args: [], expected: returns([4, 2, 2]) },
    { id: "reset", sequence: "state", reset: true, args: [], expected: returns([2, 1, 1]) },
    { id: "independent", sequence: "other", args: [], expected: returns([2, 1, 1]) }
  ]);
  const result = await execute(plan);
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});

test("a clock function captured by a dependency stays live across mocked and real-clock steps", integration, async () => {
  const result = await execute(makePlan("export {run, probe} from './clock.js';", [
    { path: "src/clock.js", source: "const now=Date.now; export const run=()=>now(); export const probe=()=>[Number.isFinite(now()),Date.now===now];" }
  ], [
    { id: "first", sequence: "clock", args: [], clock: 100, expected: { ...returns(100), clockReads: 1 } },
    { id: "second", sequence: "clock", args: [], clock: 300, expected: { ...returns(300), clockReads: 1 } },
    { id: "real", sequence: "clock", exportName: "probe", args: [], expected: { ...returns([true, true]), clockReads: 0 } },
    { id: "mock-again", sequence: "clock", args: [], clock: 500, expected: { ...returns(500), clockReads: 1 } }
  ]));
  assert.equal(result.verdict, "pass", JSON.stringify(result));
});

test("missing, bare, external, encoded, queried and escaping imports cannot fall back to host IO", integration, async () => {
  for (const specifier of ["./missing.js", "node:fs", "fs", "https://example.invalid/a.js", "file:///etc/passwd", "/etc/passwd",
    "../../outside.js", "./lib.js?x=1", "./lib.js#x", "./%6cib.js", "./.git/config", "./node_modules/x.js"]) {
    const result = await execute(makePlan(`import * as value from ${JSON.stringify(specifier)}; export const run=()=>5;`, [
      { path: "src/lib.js", source: "export const value=5" }
    ]));
    assert.equal(result.verdict, "unknown", JSON.stringify({ specifier, result }));
    assert.equal(result.execution.observation.cases[0].reason, "module-import-unsupported");
    assert.equal(result.counterexamples.length, 0);
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

test("pending microtasks and dynamic imports abstain even when a synchronous return looks correct", integration, async () => {
  for (const source of [
    "export const run=()=>{Promise.resolve().then(()=>{globalThis.later=99});return 5}",
    "export const run=()=>{import('./lib.js');return 5}",
    "import('./lib.js'); export const run=()=>5",
    "await Promise.resolve(); export const run=()=>5"
  ]) {
    const result = await execute(makePlan(source, [{ path: "src/lib.js", source: "export const value=5" }]));
    assert.equal(result.verdict, "unknown", JSON.stringify(result));
    assert.equal(result.counterexamples.length, 0);
  }
});

test("observation-time microtasks cannot escape the synchronous contract boundary", integration, async () => {
  const plan = makePlan(`export function run(){ throw new Proxy({}, { getPrototypeOf(){
    Promise.resolve().then(()=>{globalThis.later=99}); return TypeError.prototype;
  }}); }`, [], [{ id: "throw", args: [], expected: { outcome: "throw", errorClass: "TypeError" } }]);
  const result = await execute(plan);
  assert.equal(result.verdict, "unknown", JSON.stringify(result));
  assert.equal(result.execution.observation.cases[0].reason, "async-job-unsupported");
  assert.equal(result.counterexamples.length, 0);
});

test("module initialization faults and resource exhaustion are not source counterexamples", integration, async () => {
  for (const source of ["throw new Error('init')", "while(true){}", "const data=[];while(true)data.push(new Array(10000).fill(1))"]) {
    const result = await execute(makePlan("import './lib.js'; export const run=()=>5", [{ path: "src/lib.js", source }]));
    assert.equal(result.verdict, "error", JSON.stringify(result));
    assert.equal(result.counterexamples.length, 0);
    assert.equal(result.execution.cleanupConfirmed, true);
  }
});

function fixture(context) {
  const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-module-snapshot-")));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  git(projectRoot, "init", "-q"); git(projectRoot, "config", "user.name", "Test"); git(projectRoot, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(projectRoot, "main.js"), "import {add} from './lib.js'; export const run=()=>add(2,3);\n");
  fs.writeFileSync(path.join(projectRoot, "lib.js"), "export const add=(a,b)=>a+b;\n");
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "ignored.js\n");
  git(projectRoot, "add", "main.js", "lib.js", ".gitignore"); git(projectRoot, "commit", "-qm", "module graph");
  return { projectRoot, sourcePath: "main.js", modulePaths: ["lib.js"], authorizeSourceRead: () => true };
}

test("snapshots bind all authorized files including ignored dependencies, modes and graph membership", (context) => {
  const options = fixture(context), before = captureExecutionSnapshot(options);
  assert.equal(before.binding.moduleFiles.length, 2);
  assert.equal(before.binding.sourceDigest, hash(executionSourceText(before)));
  fs.chmodSync(path.join(options.projectRoot, "lib.js"), 0o755);
  assert.notEqual(captureExecutionSnapshot(options).snapshotDigest, before.snapshotDigest);
  fs.writeFileSync(path.join(options.projectRoot, "ignored.js"), "export const value=1");
  const expanded = { ...options, modulePaths: ["ignored.js", "lib.js"] }, ignoredBefore = captureExecutionSnapshot(expanded);
  fs.writeFileSync(path.join(options.projectRoot, "ignored.js"), "export const value=2");
  const after = captureExecutionSnapshot(expanded);
  assert.equal(after.binding.workingTreeDigest, ignoredBefore.binding.workingTreeDigest);
  assert.notEqual(after.binding.sourceDigest, ignoredBefore.binding.sourceDigest);
  assert.notEqual(after.snapshotDigest, ignoredBefore.snapshotDigest);
  assert.throws(() => captureExecutionSnapshot({ ...options, authorizeSourceRead: ({ sourcePath }) => sourcePath !== "lib.js" }), /not authorized/);
  fs.symlinkSync("lib.js", path.join(options.projectRoot, "linked.js"));
  assert.throws(() => captureExecutionSnapshot({ ...options, modulePaths: ["linked.js"] }), /symbolic link/);
  fs.linkSync(path.join(options.projectRoot, "lib.js"), path.join(options.projectRoot, "hardlinked.js"));
  assert.throws(() => captureExecutionSnapshot({ ...options, modulePaths: ["hardlinked.js"] }), /linked/);
});

test("actual snapshot execution rejects a changed dependency even when the entry is identical", integration, async (context) => {
  const options = fixture(context), checks = [{ id: "sum", cases: one(5) }];
  const good = await runSnapshotBoundContract({ ...options, checks, exportName: "run", imageId, dockerSocket });
  assert.equal(good.verdict, "pass", JSON.stringify(good));
  let entryReads = 0;
  const drifted = await runSnapshotBoundContract({ ...options, checks, exportName: "run", imageId, dockerSocket,
    authorizeSourceRead: ({ sourcePath }) => {
      // Three checks capture the clean entry before execution. The fourth
      // starts post-execution capture; only the dependency changes there.
      if (sourcePath === "main.js" && ++entryReads === 4) fs.writeFileSync(path.join(options.projectRoot, "lib.js"), "export const add=()=>99");
      return true;
    } });
  assert.equal(drifted.result.verdict, "pass", JSON.stringify(drifted));
  assert.equal(drifted.verdict, "unknown");
  assert.equal(drifted.reason, "execution-snapshot-drift");
});

test("the existing five-file production redactor executes unchanged against literal diagnostic contracts", integration, async () => {
  const directory = "packages/piagent-core/security/", sourcePath = `${directory}sensitive-data.js`;
  const modulePaths = ["sensitive-text.js", "sensitive-project-file.js", "sensitive-source-formats.js", "sensitive-source-expression.js"].map((name) => directory + name);
  const options = { projectRoot: path.resolve(import.meta.dirname, ".."), sourcePath, modulePaths, authorizeSourceRead: () => true,
    exportName: "redactSensitiveText", imageId, dockerSocket, checks: [{ id: "literal-public-contracts", cases: [
      { id: "plain", args: [data("ordinary status message")], expected: returns({ text: "ordinary status message", redacted: false }) },
      { id: "opaque", args: [data("Authorization: Token unit-test-value")], expected: returns({ text: "Authorization: Token [REDACTED_SECRET]", redacted: true }) },
      { id: "structured", exportName: "redactForStorage", args: [data({ nested: { password: "literal-value-42", label: "status" }, count: 0 })],
        expected: returns({ nested: { password: "[REDACTED_SECRET]", label: "status" }, count: 0 }) },
      { id: "source", exportName: "redactSensitiveProjectFileText", args: [data("config.json"), data("Authorization: Token unit-test-value\n")],
        expected: returns({ text: "Authorization: Token [REDACTED_SECRET]\n", redacted: true, lineCountPreserved: true }) }
    ] }] };
  const good = await runSnapshotBoundContract(options);
  assert.equal(good.verdict, "pass", JSON.stringify(good));
  assert.equal(good.binding.moduleFiles.length, 5);
  const snapshot = captureExecutionSnapshot(options);
  const dependencies = snapshot.moduleGraph.dependencies.map((file) => file.path.endsWith("/sensitive-text.js")
    ? { ...file, source: file.source.replace('const REDACTION = "[REDACTED_SECRET]";', 'const REDACTION = "[WRONG]";') } : file);
  const bad = await execute({ schemaVersion: 1, source: snapshot.source, moduleGraph: { ...snapshot.moduleGraph, dependencies },
    exportName: options.exportName, checks: options.checks });
  assert.equal(bad.verdict, "fail", JSON.stringify(bad));
  assert.ok(bad.counterexamples.length >= 2);
  assert.notEqual(bad.execution.sourceDigest, good.binding.sourceDigest);
  assert.equal(captureExecutionSnapshot(options).snapshotDigest, snapshot.snapshotDigest, "the production source was not edited for this in-memory mutant");
});
