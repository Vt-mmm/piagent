import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWorkspaceFile, inspectWorkspaceMedia, inspectWorkspaceTree } from "../packages/piagent-core/extensions/workspace-inspection.ts";

const policy = { policy: { protectedPaths: ["secrets/**"] }, profile: { readOnlyPaths: ["vendor/**"] } };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-explorer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "secrets")); fs.mkdirSync(path.join(root, "vendor"));
  fs.writeFileSync(path.join(root, "hello.ts"), "const answer = 42;\n");
  fs.writeFileSync(path.join(root, "secrets/token.txt"), "PRIVATE");
  fs.writeFileSync(path.join(root, "vendor/file.txt"), "readable");
  return root;
}

test("explorer reads content and digest, with protected and read-only policy", t => {
  const root = fixture(t);
  const file = inspectWorkspaceFile(root, "hello.ts", policy);
  assert.equal(file.content, "const answer = 42;\n"); assert.equal(file.language, "typescript");
  assert.match(file.digest, /^[a-f0-9]{64}$/); assert.equal(file.revision, `sha256:${file.digest}`);
  for (const name of ["secrets/token.txt", "SECRETS/token.txt"]) {
    const protectedFile = inspectWorkspaceFile(root, name, policy);
    assert.equal(protectedFile.protected, true); assert.equal(protectedFile.content, null); assert.equal(protectedFile.digest, null);
  }
  assert.equal(inspectWorkspaceFile(root, "vendor/file.txt", policy).readOnly, true);
  assert.equal(inspectWorkspaceFile(root, "hello.ts", { ...policy, readOnly: true }).readOnly, true);
  const tree = inspectWorkspaceTree(root, "", policy);
  assert.equal(tree.source, "directory"); assert.equal(tree.entries.find(e => e.name === "secrets").protected, true);
  assert.throws(() => inspectWorkspaceTree(root, "secrets", policy), /workspace-path-protected/);
});

test("explorer rejects traversal, absolute paths and symbolic links at every depth", t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-explorer-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret"), "OUTSIDE");
  fs.symlinkSync(outside, path.join(root, "linked"));
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link.txt"));
  for (const name of ["../secret", "/etc/passwd", "foo/../hello.ts", "foo\\bar", "./hello.ts", "foo//bar"]) {
    assert.throws(() => inspectWorkspaceFile(root, name, policy));
    assert.throws(() => inspectWorkspaceTree(root, name, policy));
  }
  assert.throws(() => inspectWorkspaceFile(root, "linked/secret", policy));
  assert.throws(() => inspectWorkspaceFile(root, "link.txt", policy));
  assert.throws(() => inspectWorkspaceTree(root, "linked", policy));
  assert.equal(inspectWorkspaceTree(root, "", policy).entries.find(e => e.name === "linked").kind, "symlink");
});

test("explorer omits binary and oversized content and never blocks on a FIFO", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "binary"), Buffer.from([0, 255, 1]));
  fs.writeFileSync(path.join(root, "invalid-utf8"), Buffer.from([255, 254]));
  fs.writeFileSync(path.join(root, "large"), Buffer.alloc((1 << 20) + 1, 65));
  for (const name of ["binary", "invalid-utf8"]) {
    const file = inspectWorkspaceFile(root, name, policy); assert.equal(file.binary, true); assert.equal(file.content, null);
  }
  assert.equal(inspectWorkspaceFile(root, "large", policy).oversized, true);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    assert.throws(() => inspectWorkspaceFile(root, "pipe", policy), /not a regular file/);
  }
});

test("explorer uses tracked and untracked Git files, honours ignore rules, and expands lazily", t => {
  const root = fixture(t);
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
  fs.mkdirSync(path.join(root, "ignored")); fs.writeFileSync(path.join(root, "ignored/private"), "hidden");
  execFileSync("git", ["-C", root, "add", "hello.ts"]);
  const tree = inspectWorkspaceTree(root, "", policy);
  assert.equal(tree.source, "git"); assert.ok(tree.entries.some(e => e.name === "hello.ts"));
  assert.ok(tree.entries.some(e => e.name === "vendor"));
  assert.ok(!tree.entries.some(e => e.name === "ignored" || e.name === ".git"));
  assert.deepEqual(inspectWorkspaceTree(root, "vendor", policy).entries.map(e => e.name), ["file.txt"]);
});

test("non-Git explorer bounds wide directories and reports truncation", t => {
  const root = fixture(t);
  for (let i = 0; i < 1100; i++) fs.writeFileSync(path.join(root, `file-${i}`), "");
  const tree = inspectWorkspaceTree(root, "", policy, 10);
  assert.equal(tree.entries.length, 10); assert.equal(tree.truncated, true);
  assert.equal(inspectWorkspaceTree(root, "", policy, 100000).entries.length, 1000);
});

test("project-only quick open cannot follow links or suggest protected and external paths", async t => {
  const { suggestPaths } = await import("../packages/piagent-webui/gateway/path-suggestions.ts");
  const { workspacePathFlags } = await import("../packages/piagent-core/extensions/workspace-inspection.ts");
  const root = fixture(t);
  execFileSync("git", ["init", "-q", root]);
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
  const options = { root, fd: null, projectOnly: true, isAllowed: relative => !workspacePathFlags(relative, policy).protected };
  assert.ok((await suggestPaths({ ...options, query: "hello" })).suggestions.some(entry => entry.value === "hello.ts"));
  for (const query of ["/etc/", "../", "~/", "outside/", "secrets/token"]) {
    assert.deepEqual((await suggestPaths({ ...options, query })).suggestions, [], query);
  }
});

test("an image the agent hands back is read as data for a preview; protected, other and oversized files are not", t => {
  const root = fixture(t);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  fs.mkdirSync(path.join(root, "out")); fs.writeFileSync(path.join(root, "out/chart.PNG"), png);
  fs.writeFileSync(path.join(root, "secrets/shot.png"), png);
  const media = inspectWorkspaceMedia(root, "out/chart.PNG", policy);
  assert.deepEqual(media, { path: "out/chart.PNG", mime: "image/png", data: png.toString("base64"), reasonCode: null });
  assert.deepEqual(inspectWorkspaceMedia(root, "secrets/shot.png", policy), { path: "secrets/shot.png", mime: "image/png", data: null, reasonCode: "protected" });
  assert.equal(inspectWorkspaceMedia(root, "hello.ts", policy).reasonCode, "unsupported");
  fs.writeFileSync(path.join(root, "out/huge.jpg"), Buffer.alloc((8 << 20) + 1));
  assert.equal(inspectWorkspaceMedia(root, "out/huge.jpg", policy).reasonCode, "oversized");
  assert.throws(() => inspectWorkspaceMedia(root, "../outside.png", policy));
});
