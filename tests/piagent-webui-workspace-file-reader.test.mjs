import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  WorkspaceReadError,
  hashWorkspaceFile,
  readWorkspaceFile,
  readWorkspaceLink
} from "../packages/piagent-core/runtime/inspection/workspace-file-reader.ts";

describe("Piagent WebUI workspace file reader", () => {
  it("hashes small-file histories without large temporary allocations", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-budget-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "tiny.txt"), "content\n");
    const allocate = Buffer.allocUnsafe;
    let allocated = 0;
    // Observe real allocations; do not replace the hasher or its filesystem reads.
    t.mock.method(Buffer, "allocUnsafe", function (size) {
      allocated += size;
      return allocate(size);
    });
    const expected = createHash("sha256").update("content\n").digest("hex");
    for (let index = 0; index < 1_000; index += 1) {
      assert.equal(hashWorkspaceFile(root, "tiny.txt"), expected);
    }
    assert.ok(allocated < 1024 * 1024, `small-file hashing allocated ${allocated} bytes`);
  });

  it("hashes empty and multi-chunk files exactly", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-chunks-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const size of [0, 1, 262143, 262144, 262145, 1048593]) {
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
      fs.writeFileSync(path.join(root, "file.bin"), bytes);
      assert.equal(hashWorkspaceFile(root, "file.bin"), createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("reads and hashes a stable regular file beneath the repository root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "file.txt"), "content\n");
    assert.equal(readWorkspaceFile(root, "src/file.txt", 1024).toString("utf8"), "content\n");
    assert.match(hashWorkspaceFile(root, "src/file.txt"), /^[a-f0-9]{64}$/);
  });

  it("rejects symlink ancestors instead of reading outside the repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
    fs.symlinkSync(outside, path.join(root, "linked"));
    assert.throws(
      () => readWorkspaceFile(root, "linked/secret.txt", 1024),
      (error) => error instanceof WorkspaceReadError && error.code === "symlink-ancestor"
    );
  });

  it("reads only a link target and enforces content caps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-reader-link-"));
    fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(2048));
    fs.symlinkSync("large.txt", path.join(root, "link.txt"));
    assert.equal(readWorkspaceLink(root, "link.txt"), "large.txt");
    assert.throws(
      () => readWorkspaceFile(root, "large.txt", 1024),
      (error) => error instanceof WorkspaceReadError && error.code === "oversized"
    );
  });
});
