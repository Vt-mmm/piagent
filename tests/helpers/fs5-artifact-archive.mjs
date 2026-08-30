import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../.."), directory = path.join(root, "evals/fs5-artifact-archive");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Read-only test evidence. No import or execution of the archived source.
export function verifyFs5ArtifactArchive() {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, "fs5-historical-artifact-archive");
  assert.equal(manifest.executionAuthority, false);
  const artifacts = new Map();
  for (const item of manifest.artifacts) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/); assert.match(item.retrievedFromCommit, /^[a-f0-9]{40}$/);
    assert.equal(item.archivePath, `sha256/${item.sha256}.txt`);
    const bytes = fs.readFileSync(path.join(directory, item.archivePath));
    assert.equal(bytes.length, item.byteLength); assert.equal(digest(bytes), item.sha256, item.path);
    const key = `${item.path}:${item.sha256}`;
    assert.equal(artifacts.has(key), false); artifacts.set(key, bytes);
  }
  assert.equal(manifest.protocols.length, 5);
  const used = new Set();
  for (const [index, item] of manifest.protocols.entries()) {
    assert.equal(item.path, `evals/fs5-pilot-protocol.v${index + 1}.json`);
    const bytes = fs.readFileSync(path.join(root, item.path));
    assert.equal(digest(bytes), item.sha256, "historical protocol bytes must remain unchanged");
    for (const binding of JSON.parse(bytes).artifactBindings) {
      const key = `${binding.path}:${binding.sha256}`;
      assert.ok(artifacts.has(key), `Missing archived bytes: ${key}`); used.add(key);
    }
  }
  assert.deepEqual([...artifacts.keys()].sort(), [...used].sort(), "archive contains exactly the declared historical artifacts");
  return artifacts;
}

export function materializeFs5ArtifactFixture(protocol, candidateRoot) {
  const artifacts = verifyFs5ArtifactArchive();
  for (const binding of protocol.artifactBindings) {
    assert.ok(!binding.path.split("/").some((part) => ["", ".", ".."].includes(part)));
    const file = path.join(candidateRoot, binding.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, artifacts.get(`${binding.path}:${binding.sha256}`), { flag: "wx" });
  }
}
