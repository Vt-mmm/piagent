import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeBinarySha256 } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";

test("bounded runtime identity hashing covers full chunks and the final partial chunk", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture"), bytes = Buffer.alloc(2 * 1024 * 1024 + 137);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 251;
  fs.writeFileSync(file, bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(runtimeBinarySha256(file), expected);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  assert.notEqual(runtimeBinarySha256(file), expected, "a tail-byte change cannot retain identity");
  assert.equal(runtimeBinarySha256(file), createHash("sha256").update(bytes).digest("hex"));
  fs.truncateSync(file, 0); assert.equal(runtimeBinarySha256(file), createHash("sha256").digest("hex"));
  assert.throws(() => runtimeBinarySha256(path.join(root, "absent")), /ENOENT/);
});
