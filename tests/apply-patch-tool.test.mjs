import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ApplyPatchError,
  applyValidatedPatch,
  parseApplyPatchTargets,
  registerApplyPatchTool
} from "../packages/piagent-core/runtime/tools/apply-patch-tool.ts";

const roots = new Set();

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-apply-patch-"));
  roots.add(root);
  return root;
}

function patch(...lines) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function errorCode(code) {
  return (error) => error instanceof ApplyPatchError && error.code === code;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("registers one sequential guarded apply_patch tool and applies multi-file Add/Update", async () => {
  const root = project();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "value.js"), "export const value = 1;\nexport const keep = true;\n", { mode: 0o755 });
  const registered = [];
  const Type = { String: (options) => ({ type: "string", ...options }), Object: (properties, options) => ({ type: "object", properties, ...options }) };
  registerApplyPatchTool({ registerTool: (definition) => registered.push(definition) }, Type);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "apply_patch");
  assert.equal(registered[0].executionMode, "sequential");
  const input = {
    patch: patch(
      "*** Update File: src/value.js",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      " export const keep = true;",
      "*** Add File: test/value.test.js",
      "+import assert from 'node:assert/strict';",
      "+assert.equal(2, 2);"
    )
  };
  const result = await registered[0].execute("patch-1", input, undefined, undefined, { cwd: root });

  assert.deepEqual(result.details, {
    changedPaths: ["src/value.js", "test/value.test.js"],
    updatedPaths: ["src/value.js"],
    addedPaths: ["test/value.test.js"]
  });
  assert.equal(fs.readFileSync(path.join(root, "src", "value.js"), "utf8"), "export const value = 2;\nexport const keep = true;\n");
  assert.equal(fs.statSync(path.join(root, "src", "value.js")).mode & 0o777, 0o755, "updates preserve file mode");
  assert.equal(fs.readFileSync(path.join(root, "test", "value.test.js"), "utf8"), "import assert from 'node:assert/strict';\nassert.equal(2, 2);\n");
  assert.deepEqual(fs.readdirSync(path.join(root, "src")), ["value.js"], "transaction artifacts are removed");
});

test("registers the intentional override without calling pre-bind host actions", () => {
  const registered = [];
  let getAllToolsCalls = 0;
  const Type = { String: () => ({}), Object: () => ({}) };
  registerApplyPatchTool({
    getAllTools: () => {
      getAllToolsCalls += 1;
      throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    },
    registerTool: (definition) => registered.push(definition)
  }, Type);
  assert.equal(getAllToolsCalls, 0);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "apply_patch");
});

test("validates every target and hunk before writing any file", () => {
  const root = project();
  fs.mkdirSync(path.join(root, "src"));
  const first = path.join(root, "src", "first.js");
  const repeated = path.join(root, "src", "repeated.js");
  fs.writeFileSync(first, "export const first = 1;\n");
  fs.writeFileSync(repeated, "repeat\nseparator\nrepeat\n");

  assert.throws(() => applyValidatedPatch(root, patch(
    "*** Update File: src/first.js",
    "@@",
    "-export const first = 1;",
    "+export const first = 2;",
    "*** Update File: src/repeated.js",
    "@@",
    "-repeat",
    "+changed"
  )), errorCode("ambiguous-hunk"));
  assert.equal(fs.readFileSync(first, "utf8"), "export const first = 1;\n", "an earlier valid section is not partially written");
  assert.equal(fs.readFileSync(repeated, "utf8"), "repeat\nseparator\nrepeat\n");

  assert.throws(() => applyValidatedPatch(root, patch(
    "*** Add File: new.js", "+new",
    "*** Add File: new.js", "+duplicate"
  )), errorCode("duplicate-target"));
  assert.throws(() => applyValidatedPatch(root, patch(
    "*** Add File: nested", "+file",
    "*** Add File: nested/child.js", "+child"
  )), errorCode("overlapping-target"));
  assert.equal(fs.existsSync(path.join(root, "new.js")), false);
});

test("bounds global hunk count and exact-match scanning before writing", () => {
  const hunkRoot = project();
  fs.writeFileSync(path.join(hunkRoot, "first.txt"), "first old\n");
  fs.writeFileSync(path.join(hunkRoot, "second.txt"), "second old\n");
  const manyHunks = (prefix, count) => Array.from({ length: count }, (_, index) => [
    "@@",
    `-${prefix}-${index}`,
    `+${prefix}-changed-${index}`
  ]).flat();
  assert.throws(() => applyValidatedPatch(hunkRoot, patch(
    "*** Update File: first.txt",
    ...manyHunks("first", 600),
    "*** Update File: second.txt",
    ...manyHunks("second", 600)
  )), errorCode("too-many-hunks"));
  assert.equal(fs.readFileSync(path.join(hunkRoot, "first.txt"), "utf8"), "first old\n");
  assert.equal(fs.readFileSync(path.join(hunkRoot, "second.txt"), "utf8"), "second old\n");

  const scanRoot = project();
  const lines = Array.from({ length: 20_000 }, (_, index) => `line-${index}`);
  const target = path.join(scanRoot, "large.txt");
  const before = `${lines.join("\n")}\n`;
  fs.writeFileSync(target, before);
  const startedAt = performance.now();
  assert.throws(() => applyValidatedPatch(scanRoot, patch(
    "*** Update File: large.txt",
    ...Array.from({ length: 400 }, (_, index) => {
      const line = lines[lines.length - 1 - index];
      return ["@@", `-${line}`, `+changed-${index}`];
    }).flat()
  )), errorCode("work-limit"));
  assert.ok(performance.now() - startedAt < 2_000, "bounded matching must reject without an event-loop-scale stall");
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.deepEqual(fs.readdirSync(scanRoot), ["large.txt"], "work-limit failure leaves no transaction residue");
});

test("exposes the executor's exact fail-closed target parser to authorization", () => {
  assert.deepEqual(parseApplyPatchTargets(patch(
    "*** Add File: src/one.ts", "+export const one = 1;",
    "*** Update File: src/two.ts", "@@", "-old", "+new"
  )), ["src/one.ts", "src/two.ts"]);

  for (const malformed of [
    patch(),
    patch("*** Delete File: src/one.ts"),
    patch("*** Add File: src/one.ts", "unprefixed"),
    patch("*** Update File: src/one.ts", "@@", "+contextless"),
    patch("*** Add File: src/one.ts", "+one", "*** Add File: src/one.ts", "+two")
  ]) {
    assert.throws(() => parseApplyPatchTargets(malformed), ApplyPatchError);
  }

  for (const unsafeTarget of [
    ".git/%ZZ",
    ".env.%ZZ",
    "src/readonly/%ZZ.ts",
    "docs/%ZZ.ts",
    "src/%2e.ts",
    "src/%2f.ts"
  ]) {
    assert.throws(
      () => parseApplyPatchTargets(patch(`*** Add File: ${unsafeTarget}`, "+blocked")),
      errorCode("unsafe-path"),
      unsafeTarget
    );
  }
});

test("fails closed on absolute, traversal, symlink, and malformed targets without residue", (t) => {
  const root = project();
  const outside = project();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "plain.js"), "plain\n");
  fs.writeFileSync(path.join(outside, "outside.js"), "outside\n");
  fs.symlinkSync(path.join(outside, "outside.js"), path.join(root, "src", "link.js"));
  fs.symlinkSync(outside, path.join(root, "linked"));

  const cases = [
    ["absolute", patch(`*** Add File: ${path.join(outside, "added.js")}`, "+blocked"), "unsafe-path"],
    ["traversal", patch("*** Add File: ../outside.js", "+blocked"), "unsafe-path"],
    ["control character", patch("*** Add File: src/bad\tname.js", "+blocked"), "unsafe-path"],
    ["target symlink", patch("*** Update File: src/link.js", "@@", "-outside", "+changed"), "unsafe-target"],
    ["ancestor symlink", patch("*** Add File: linked/added.js", "+blocked"), "symlink-path"],
    ["contextless insertion", patch("*** Update File: src/plain.js", "@@", "+insert"), "malformed-hunk"],
    ["unsupported delete", patch("*** Delete File: src/link.js"), "invalid-patch"],
    ["invalid percent escape", patch("*** Add File: .git/%ZZ", "+blocked"), "unsafe-path"],
    ["encoded dot", patch("*** Add File: src/%2e.ts", "+blocked"), "unsafe-path"],
    ["encoded slash", patch("*** Add File: src/%2f.ts", "+blocked"), "unsafe-path"]
  ];
  for (const [name, value, code] of cases) {
    assert.throws(() => applyValidatedPatch(root, value), errorCode(code), name);
  }
  assert.equal(fs.readFileSync(path.join(outside, "outside.js"), "utf8"), "outside\n");
  assert.equal(fs.existsSync(path.join(outside, "added.js")), false);
  assert.deepEqual(fs.readdirSync(root).sort(), ["linked", "src"]);
});

test("honors cancellation before creating parents or changing content", () => {
  const root = project();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => applyValidatedPatch(root, patch("*** Add File: nested/new.js", "+blocked"), controller.signal), errorCode("cancelled"));
  assert.equal(fs.existsSync(path.join(root, "nested")), false);
});

test("rolls back an Add target when stage cleanup fails after the no-clobber link", () => {
  const root = project();
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && String(target).includes(".piagent-stage.")) {
      injected = true;
      const error = new Error("injected stage unlink failure");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    assert.throws(() => applyValidatedPatch(root, patch("*** Add File: added.js", "+must roll back")), /injected stage unlink failure/);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(root, "added.js")), false, "linked destination is included in rollback immediately");
  assert.deepEqual(fs.readdirSync(root), [], "the failed transaction leaves no stage or backup artifact");
});

test("rolls back every update when a later backup cleanup fails", () => {
  const root = project();
  fs.writeFileSync(path.join(root, "first.js"), "first old\n");
  fs.writeFileSync(path.join(root, "second.js"), "second old\n");
  const originalUnlink = fs.unlinkSync;
  let backupCleanupCount = 0;
  fs.unlinkSync = (target) => {
    if (String(target).includes(".piagent-backup.") && ++backupCleanupCount === 2) {
      const error = new Error("injected backup cleanup failure");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink(target);
  };
  try {
    assert.throws(() => applyValidatedPatch(root, patch(
      "*** Update File: first.js", "@@", "-first old", "+first new",
      "*** Update File: second.js", "@@", "-second old", "+second new"
    )), /injected backup cleanup failure/);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(backupCleanupCount, 2, "failure occurs after one rollback hardlink was already removed");
  assert.equal(fs.readFileSync(path.join(root, "first.js"), "utf8"), "first old\n");
  assert.equal(fs.readFileSync(path.join(root, "second.js"), "utf8"), "second old\n");
  assert.deepEqual(fs.readdirSync(root).sort(), ["first.js", "second.js"], "cleanup failure leaves no hidden backup residue");
});

test("rollback preserves a concurrent update and leaves the original preimage recoverable", () => {
  const root = project();
  const first = path.join(root, "first.js");
  const second = path.join(root, "second.js");
  fs.writeFileSync(first, "first old\n");
  fs.writeFileSync(second, "second old\n");
  const originalUnlink = fs.unlinkSync;
  let backupCleanupCount = 0;
  fs.unlinkSync = (target) => {
    if (String(target).includes(".piagent-backup.") && ++backupCleanupCount === 2) {
      fs.writeFileSync(first, "first concurrent\n");
      const error = new Error("injected cleanup failure after concurrent write");
      error.code = "EIO";
      throw error;
    }
    return originalUnlink(target);
  };
  let failure;
  try {
    applyValidatedPatch(root, patch(
      "*** Update File: first.js", "@@", "-first old", "+first new",
      "*** Update File: second.js", "@@", "-second old", "+second new"
    ));
  } catch (error) {
    failure = error;
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.ok(failure instanceof ApplyPatchError);
  assert.equal(failure.code, "rollback-incomplete");
  assert.match(failure.message, /first\.js/);
  assert.equal(fs.readFileSync(first, "utf8"), "first concurrent\n", "rollback must not clobber a concurrent post-commit write");
  assert.equal(fs.readFileSync(second, "utf8"), "second old\n", "uncontested targets still roll back");
  const recoveryBackups = fs.readdirSync(root).filter((name) => name.startsWith(".first.js.piagent-backup."));
  assert.equal(recoveryBackups.length, 1);
  assert.equal(fs.readFileSync(path.join(root, recoveryBackups[0]), "utf8"), "first old\n");
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".piagent-stage.")), false);
});
