import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  WorkspaceReadError,
  hashWorkspaceFile,
  readWorkspaceFile,
  readWorkspaceLink
} from "../packages/piagent-core/runtime/inspection/workspace-file-reader.ts";

describe("Piagent WebUI workspace file reader", () => {
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
