import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FACT_EVIDENCE_SCOPE_VERSION, openAcceptanceEvidenceStore, ROOT_AGGREGATE_FACT_ID } from "../packages/piagent-core/extensions/acceptance-evidence-store.js";
import { createAcceptanceAssessmentSession } from "../packages/piagent-core/extensions/acceptance-assessment.js";

const modulePath = fileURLToPath(new URL("../packages/piagent-core/extensions/acceptance-evidence-store.js", import.meta.url));
const scope = { taskRunId: "task-1", criterionId: "behavior" };
const binding = () => Object.fromEntries(["criterionHash", "snapshotDigest", "verifierDigest", "projectVerificationDigest", "planDigest", "backendDigest"].map((field, index) => [field, String(index).repeat(64)]));
const payload = JSON.stringify({ verdict: "pass", checks: [{ id: "behavior", status: "pass", caseCount: 3, counterexampleRef: null }] });

function fixture(context) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-evidence-store-")));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project"), state = path.join(directory, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const options = { filePath: path.join(state, "evidence.sqlite"), projectRoot, key: createSecretKey(randomBytes(32)) };
  const opened = [];
  const open = (overrides = {}) => { const store = openAcceptanceEvidenceStore({ ...options, ...overrides }); opened.push(store); return store; };
  context.after(() => { for (const store of opened) store.close(); });
  return { directory, options, open };
}
const reserve = (store, overrides = {}) => store.reserve({ scope, binding: binding(), maxAttempts: 3, ...overrides });

test("settled authenticated evidence survives closing and reopening with the host key", (context) => {
  const { open } = fixture(context);
  const first = open();
  assert.equal(first.latest(scope), null);
  const started = reserve(first);
  assert.equal(started.status, "reserved");
  assert.equal(started.event.attempt, 1);
  first.settle(started.reservation, payload);
  first.close();
  const reopened = open(), cached = reserve(reopened);
  assert.equal(cached.status, "current");
  assert.equal(cached.event.attempt, 1);
  assert.equal(cached.event.evidenceText, payload);
  assert.equal(Object.isFrozen(cached.event.binding), true);
  assert.equal(reopened.latest(scope).sequence, 2);
});

test("versioned fact scopes separate sibling children while preserving the legacy criterion scope", (context) => {
  const { open } = fixture(context), store = open();
  const code = { version: FACT_EVIDENCE_SCOPE_VERSION, taskRunId: scope.taskRunId, criterionId: scope.criterionId, factId: "code" };
  const sibling = { ...code, factId: "code-sibling" }, root = { ...code, factId: ROOT_AGGREGATE_FACT_ID };
  const started = reserve(store, { scope: code }); store.settle(started.reservation, payload);
  assert.equal(store.latest(code).phase, "settled"); assert.equal(store.latest(sibling), null); assert.equal(store.latest(scope), null);
  assert.equal(reserve(store, { scope: root }).status, "reserved", "the reserved root identity is explicit, never aliased to a child");
  assert.throws(() => store.latest({ ...code, extra: true }), /fields/);
  assert.throws(() => store.latest({ ...code, version: "unknown-scope-v2" }), /fields/);
});

test("pending attempts cannot pass or silently execute again after restart", (context) => {
  const { open } = fixture(context);
  const first = open(), pending = reserve(first);
  first.close();
  const reopened = open();
  assert.equal(reserve(reopened).status, "pending");
  assert.equal(reserve(reopened, { binding: { ...binding(), snapshotDigest: "a".repeat(64) }, retry: true }).status, "pending");
  assert.throws(() => reopened.settle(pending.reservation, payload), /Untrusted/);
  assert.throws(() => reopened.recordStoppedAttempt({ scope, attemptId: pending.event.attemptId }), /stop must be established/);
  assert.throws(() => reopened.recordStoppedAttempt({ scope, attemptId: "wrong", executorStopped: true }), /No matching/);
  reopened.recordStoppedAttempt({ scope, attemptId: pending.event.attemptId, executorStopped: true });
  assert.equal(reserve(reopened).status, "interrupted");
  const retried = reserve(reopened, { retry: true });
  assert.equal(retried.event.attempt, 2);
  assert.equal(retried.status, "reserved");
});

test("settlement requires a live one-shot reservation from this exact store handle", (context) => {
  const { open } = fixture(context);
  const store = open(), started = reserve(store), other = open();
  for (const forged of [{ ...started.reservation }, JSON.parse(JSON.stringify(started.reservation)), {}, null]) {
    assert.throws(() => store.settle(forged, payload), /Untrusted/);
  }
  assert.throws(() => other.settle(started.reservation, payload), /Untrusted/);
  assert.equal(reserve(other).status, "pending");
  store.settle(started.reservation, payload);
  assert.throws(() => store.settle(started.reservation, payload), /Untrusted/);
});

test("an interrupted live attempt cannot later overwrite the terminal state", (context) => {
  const { open } = fixture(context);
  const store = open(), started = reserve(store), other = open();
  other.recordStoppedAttempt({ scope, attemptId: started.event.attemptId, executorStopped: true });
  assert.throws(() => store.settle(started.reservation, payload), /no longer pending/);
  assert.equal(store.latest(scope).phase, "interrupted");
});

test("every binding change invalidates cache reuse and spends a new finite attempt", (context) => {
  const { open } = fixture(context), store = open();
  for (const [index, field] of Object.keys(binding()).entries()) {
    const perCriterion = { ...scope, criterionId: `criterion-${index}` };
    const started = reserve(store, { scope: perCriterion });
    store.settle(started.reservation, payload);
    const changed = reserve(store, { scope: perCriterion, binding: { ...binding(), [field]: "f".repeat(64) } });
    assert.equal(changed.status, "reserved", field);
    assert.equal(changed.event.attempt, 2, field);
    store.settle(changed.reservation, JSON.stringify({ verdict: "fail", counterexample: field }));
  }
});

test("latest failed evidence replaces older passing evidence, and budgets cannot expand", (context) => {
  const { open } = fixture(context), store = open();
  const first = reserve(store); store.settle(first.reservation, payload);
  const second = reserve(store, { retry: true }); store.settle(second.reservation, '{"verdict":"fail"}');
  const current = reserve(store);
  assert.equal(current.status, "current");
  assert.equal(current.event.evidenceText, '{"verdict":"fail"}');
  assert.throws(() => reserve(store, { maxAttempts: 4 }), /budget cannot change/);
  const third = reserve(store, { retry: true }); store.settle(third.reservation, '{"verdict":"error"}');
  assert.equal(reserve(store, { retry: true }).status, "exhausted");
  assert.equal(reserve(store, { binding: { ...binding(), snapshotDigest: "e".repeat(64) } }).status, "exhausted");
  assert.equal(store.latest(scope).sequence, 6);
});

test("wrong keys, copied database paths, and another project cannot authenticate stored facts", (context) => {
  const { open, options, directory } = fixture(context), store = open();
  store.settle(reserve(store).reservation, payload); store.close();
  assert.throws(() => open({ key: createSecretKey(randomBytes(32)) }), /unauthenticated/);
  const copied = path.join(path.dirname(options.filePath), "copied.sqlite");
  fs.copyFileSync(options.filePath, copied);
  assert.throws(() => open({ filePath: copied }), /unauthenticated/);
  const another = path.join(directory, "another-project"); fs.mkdirSync(another, { mode: 0o700 });
  assert.throws(() => open({ projectRoot: another }), /unauthenticated/);
  assert.equal(reserve(open()).status, "current");
});

test("altered payloads, sequence gaps, and cross-scope event copies fail authentication", async (context) => {
  for (const mode of ["payload", "gap", "scope"]) await context.test(mode, (child) => {
    const { open, options } = fixture(child), store = open();
    store.settle(reserve(store).reservation, payload);
    const differentScope = { ...scope, criterionId: "another" };
    store.settle(reserve(store, { scope: differentScope }).reservation, payload); store.close();
    const db = new DatabaseSync(options.filePath);
    const [firstScope, secondScope] = db.prepare("SELECT DISTINCT scope FROM events ORDER BY scope").all().map((row) => row.scope);
    if (mode === "payload") db.prepare("UPDATE events SET payload=? WHERE sequence=2").run('{"verdict":"pass"}');
    if (mode === "gap") db.exec("DELETE FROM events WHERE sequence=1");
    if (mode === "scope") {
      const from = db.prepare("SELECT payload,signature FROM events WHERE scope=? AND sequence=2").get(firstScope);
      db.prepare("UPDATE events SET payload=?,signature=? WHERE scope=? AND sequence=2").run(from.payload, from.signature, secondScope);
    }
    db.close();
    const reopened = open();
    const outcomes = [scope, differentScope].map((target) => { try { reopened.latest(target); return false; } catch { return true; } });
    assert.ok(outcomes.some(Boolean));
    if (mode !== "scope") assert.ok(outcomes.every(Boolean));
  });
});

test("storage refuses project-local, public, symlink, hardlink, and malformed authority state", (context) => {
  const { open, options, directory } = fixture(context);
  assert.throws(() => open({ filePath: path.join(options.projectRoot, "evidence.sqlite") }), /outside/);
  assert.throws(() => open({ key: Buffer.alloc(32) }), /secret key/);
  assert.throws(() => open({ key: createSecretKey(Buffer.alloc(16)) }), /secret key/);
  const publicDirectory = path.join(directory, "public"); fs.mkdirSync(publicDirectory, { mode: 0o755 });
  assert.throws(() => open({ filePath: path.join(publicDirectory, "evidence.sqlite") }), /private/);
  const store = open(); store.close();
  const linked = path.join(path.dirname(options.filePath), "linked.sqlite");
  fs.symlinkSync(options.filePath, linked);
  assert.throws(() => open({ filePath: linked }), /regular/);
  const hardlinked = path.join(path.dirname(options.filePath), "hardlinked.sqlite"); fs.linkSync(options.filePath, hardlinked);
  assert.throws(() => open(), /unlinked/); fs.unlinkSync(hardlinked);
  fs.chmodSync(options.filePath, 0o644); assert.throws(() => open(), /private/); fs.chmodSync(options.filePath, 0o600);
  fs.writeFileSync(options.filePath, "partial initialization", { mode: 0o600 });
  assert.throws(() => open(), /database/);
  assert.equal(fs.readFileSync(options.filePath, "utf8"), "partial initialization");
});

test("invalid records and oversized payloads do not consume or settle attempts", (context) => {
  const { open } = fixture(context), store = open();
  const accessor = binding(); Object.defineProperty(accessor, "planDigest", { get() { throw new Error("getter must not run"); } });
  for (const bad of [{}, { ...binding(), extra: true }, { ...binding(), planDigest: "bad" }, accessor]) {
    assert.throws(() => reserve(store, { binding: bad }), /Invalid evidence/);
  }
  for (const maxAttempts of [0, 9, Infinity, "3"]) assert.throws(() => reserve(store, { maxAttempts }), /budget/);
  assert.equal(store.latest(scope), null);
  const started = reserve(store);
  for (const value of [null, "null", "true", "[]", "{", JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) })]) {
    assert.throws(() => store.settle(started.reservation, value));
    assert.equal(store.latest(scope).phase, "reserved");
  }
  store.settle(started.reservation, payload);
});

test("the assessment kernel accepts canonical null references but not serialized receipt authority", () => {
  const digest = "a".repeat(64), tree = `wt-content-v2:${digest}`;
  const input = { taskRunId: "task-1", criterionHash: digest, workingTreeDigest: tree, verifierDigest: digest, requiredCheckIds: ["behavior"] };
  const first = createAcceptanceAssessmentSession(input);
  const receipt = first.observeExecution({ runId: "run-1", taskRunId: "task-1", criterionHash: digest, verifierDigest: digest,
    beforeWorkingTreeDigest: tree, afterWorkingTreeDigest: tree, completion: "completed", checks: JSON.parse(payload).checks });
  const serialized = JSON.parse(JSON.stringify(receipt));
  const second = createAcceptanceAssessmentSession(input);
  const assessContext = { currentWorkingTreeDigest: tree, policy: "allow", projectVerifierCurrent: true };
  assert.equal(second.assess({ ...assessContext, receipt: serialized }).verdict, "unknown");
  // Only a trusted host admission step may invoke observeExecution after authentication.
  assert.equal(second.assess({ ...assessContext, receipt: second.observeExecution(serialized) }).verdict, "pass");
});

test("a killed host leaves one durable pending attempt; an uncommitted transaction rolls back", { timeout: 15000 }, async (context) => {
  const { open, options } = fixture(context), store = open(); store.close();
  const script = `import { openAcceptanceEvidenceStore } from ${JSON.stringify(modulePath)};
    import { createSecretKey } from "node:crypto";
    import { DatabaseSync } from "node:sqlite";
    const input=JSON.parse(process.env.PIAGENT_EVIDENCE_TEST_INPUT);
    const store=openAcceptanceEvidenceStore({...input.options,key:createSecretKey(Buffer.from(input.key,"hex"))});
    store.reserve(input.request);
    const db=new DatabaseSync(input.options.filePath); db.exec("BEGIN IMMEDIATE; UPDATE events SET payload='uncommitted'");
    process.send("ready"); setInterval(()=>{},1000);`;
  const input = { options: { filePath: options.filePath, projectRoot: options.projectRoot }, key: options.key.export().toString("hex"),
    request: { scope, binding: binding(), maxAttempts: 3 } };
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PIAGENT_EVIDENCE_TEST_INPUT: JSON.stringify(input) } });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let errors = ""; child.stderr.on("data", (data) => { errors += data; });
  await new Promise((resolve, reject) => { child.once("message", resolve); child.once("exit", () => reject(new Error(errors))); child.once("error", reject); });
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
  const reopened = open();
  assert.equal(reserve(reopened).status, "pending");
  assert.equal(reopened.latest(scope).sequence, 1);
  assert.equal(reopened.latest(scope).attempt, 1);
});

test("a separate process authenticates completed evidence without inheriting a live receipt", (context) => {
  const { open, options } = fixture(context), store = open(); store.settle(reserve(store).reservation, payload); store.close();
  const script = `import {openAcceptanceEvidenceStore} from ${JSON.stringify(modulePath)}; import {createSecretKey} from 'node:crypto';
    const input=JSON.parse(process.env.PIAGENT_EVIDENCE_TEST_INPUT);
    const store=openAcceptanceEvidenceStore({...input.options,key:createSecretKey(Buffer.from(input.key,'hex'))});
    process.stdout.write(JSON.stringify(store.latest(input.scope))); store.close();`;
  const input = { options: { filePath: options.filePath, projectRoot: options.projectRoot }, key: options.key.export().toString("hex"), scope };
  const value = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PIAGENT_EVIDENCE_TEST_INPUT: JSON.stringify(input) }, stdio: ["ignore", "pipe", "pipe"], timeout: 5000, encoding: "utf8"
  }));
  assert.equal(value.phase, "settled"); assert.equal(value.evidenceText, payload);
});
