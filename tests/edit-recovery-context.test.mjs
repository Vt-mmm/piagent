import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEditRecoveryContext } from "../packages/piagent-core/runtime/recovery/edit-recovery-context.ts";
import { EditRecoveryDeliveryState } from "../packages/piagent-core/runtime/recovery/edit-recovery-delivery.ts";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-edit-recovery-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  return cwd;
}

test("attaches one bounded exact current source file after a classified edit mismatch", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "value.js"), "export const value = 1;\n");

  const recovery = buildEditRecoveryContext({
    cwd,
    targetPath: "src/value.js",
    reasonCode: "edit-anchor-stale",
    protectedPaths: []
  });

  assert.equal(recovery?.targetPath, "src/value.js");
  assert.match(recovery?.text ?? "", /replaces a separate reread/);
  assert.match(recovery?.text ?? "", /entire snapshot as oldText in one exact replacement/);
  assert.match(recovery?.text ?? "", /never use an unconditional whole-file write/);
  assert.match(recovery?.text ?? "", /export const value = 1/);
  assert.equal(recovery?.redacted, false);
  assert.match(recovery?.contentHash ?? "", /^[a-f0-9]{64}$/);
});

test("fails closed for secrets, credential dotfiles, unrelated failures, protected paths, symlinks, outside paths, and large files", (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-edit-recovery-outside-"));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(cwd, "src", "small.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "secret.js"), "export const password = \"secret-example-value-12345\";\n");
  fs.writeFileSync(path.join(cwd, ".netrc"), "machine api.example login alice password hunter2\n");
  fs.writeFileSync(path.join(cwd, ".pi", "private.js"), "private\n");
  fs.symlinkSync(path.join(cwd, ".pi"), path.join(cwd, "public"));
  fs.writeFileSync(path.join(outside, "outside.js"), "outside\n");
  fs.symlinkSync(path.join(outside, "outside.js"), path.join(cwd, "src", "link.js"));
  fs.writeFileSync(path.join(cwd, "src", "large.js"), "x".repeat(8_193));

  const base = { cwd, reasonCode: "edit-anchor-stale", protectedPaths: [] };
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "src/small.js", reasonCode: "tool-result-failed" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "src/secret.js" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: ".netrc" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: ".pi/private.js" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "public/private.js" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "src/small.js", protectedPaths: ["src/**"] }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "src/link.js" }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: path.join(outside, "outside.js") }), undefined);
  assert.equal(buildEditRecoveryContext({ ...base, targetPath: "src/large.js" }), undefined);
});

test("rejects a file that grows after the descriptor size check", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, "src", "racing.js");
  fs.writeFileSync(target, "ok\n");
  const originalFstatSync = fs.fstatSync;
  let interposed = false;
  fs.fstatSync = function interposedFstatSync(descriptor, options) {
    const stat = originalFstatSync.call(fs, descriptor, options);
    if (!interposed) {
      interposed = true;
      fs.appendFileSync(target, "x".repeat(9_000));
    }
    return stat;
  };
  t.after(() => { fs.fstatSync = originalFstatSync; });

  assert.equal(buildEditRecoveryContext({
    cwd,
    targetPath: "src/racing.js",
    reasonCode: "edit-anchor-stale",
    protectedPaths: []
  }), undefined);
});

test("delivery state remains bounded without allowing same-epoch reinjection", () => {
  const delivery = new EditRecoveryDeliveryState();
  const context = (id) => ({ cwd: `/project/${id}`, sessionManager: { getSessionId: () => id } });
  const first = context("first");
  assert.equal(delivery.reserve(first, "task", "file-hash"), true);
  for (let index = 0; index < 40; index += 1) delivery.advanceEpoch(context(`other-${index}`));
  assert.equal(delivery.reserve(first, "task", "file-hash"), false,
    "activity in other sessions cannot evict same-epoch suppression");
  for (let index = 1; index < 16; index += 1) assert.equal(delivery.reserve(first, "task", `file-${index}`), true);
  assert.equal(delivery.reserve(first, "task", "file-overflow"), false,
    "the per-epoch cap refuses new snapshots instead of evicting old keys");
  assert.equal(delivery.reserve(first, "task", "file-hash"), false);
  delivery.advanceEpoch(first);
  assert.equal(delivery.reserve(first, "task", "file-hash"), true);
  assert.equal(delivery.reserve(first, "task", "file-hash"), false);
});
