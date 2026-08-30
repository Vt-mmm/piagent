import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { benchmarkArtifactBindingErrors, benchmarkArtifactBindingShapeErrors } from "../packages/piagent-core/benchmark/benchmark-artifact-binding.js";

const binding = { id: "fixture", path: "source.txt", sha256: createHash("sha256").update("original\n").digest("hex") };
function directory(context) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-artifact-binding-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("artifact bindings reject malformed, ambiguous and escaping paths before file reads", () => {
  for (const candidate of [null, [], Array(65).fill(binding), [binding, binding], [{ ...binding, extra: true }],
    [{ ...binding, id: "" }], [{ ...binding, sha256: null }],
    ...["../outside", "/absolute", "src/../outside", "src//file", ".git/config", "src/./file", "C:\\file", "nul\0file"].map((p) => [{ ...binding, path: p }])]) {
    assert.ok(benchmarkArtifactBindingShapeErrors(candidate).length > 0);
    assert.ok(benchmarkArtifactBindingErrors(candidate, "/unused-root").length > 0);
  }
});

test("current verification refuses changed, missing, symlinked and non-file artifacts", (context) => {
  const root = directory(context), file = path.join(root, binding.path);
  fs.writeFileSync(file, "original\n");
  assert.deepEqual(benchmarkArtifactBindingErrors([binding], root), []);
  fs.appendFileSync(file, "changed\n");
  assert.deepEqual(benchmarkArtifactBindingErrors([binding], root), ["artifact-digest-mismatch:source.txt"]);
  fs.writeFileSync(file, "original\n");
  fs.symlinkSync(file, path.join(root, "alias.txt"));
  fs.mkdirSync(path.join(root, "real-directory"));
  fs.writeFileSync(path.join(root, "real-directory/source.txt"), "original\n");
  fs.symlinkSync(path.join(root, "real-directory"), path.join(root, "alias-directory"));
  for (const p of ["absent.txt", "alias.txt", "real-directory", "alias-directory/source.txt"]) {
    assert.deepEqual(benchmarkArtifactBindingErrors([{ ...binding, path: p }], root), [`artifact-unavailable-or-unsafe:${p}`]);
  }
  for (const unavailable of [null, "relative", path.join(root, "absent"), file]) {
    assert.deepEqual(benchmarkArtifactBindingErrors([binding], unavailable), ["artifact-source-root-unavailable"]);
  }
});

test("artifact reads are bounded and never reuse an archive or a previously matching digest", (context) => {
  const root = directory(context), file = path.join(root, binding.path);
  fs.writeFileSync(file, "original\n");
  assert.deepEqual(benchmarkArtifactBindingErrors([binding], root), []);
  fs.mkdirSync(path.join(root, "archive")); fs.copyFileSync(file, path.join(root, "archive/source.txt"));
  fs.writeFileSync(file, "");
  assert.deepEqual(benchmarkArtifactBindingErrors([binding], root), ["artifact-unavailable-or-unsafe:source.txt"]);
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.deepEqual(benchmarkArtifactBindingErrors([binding], root), ["artifact-unavailable-or-unsafe:source.txt"]);
});
