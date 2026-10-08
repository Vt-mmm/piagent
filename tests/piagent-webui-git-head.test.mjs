import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { readGitHead } from "../packages/piagent-webui/gateway/git-head.ts";
import { buildSessionCatalog } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
  { cwd, stdio: "pipe" }).toString().trim();

function info(file, cwd) {
  return { path: file, id: path.basename(file), cwd, created: new Date("2026-10-08T01:00:00Z"), modified: new Date("2026-10-08T01:00:00Z"),
    messageCount: 1, firstMessage: "hello", allMessagesText: "hello" };
}

describe("Piagent Gateway Git branch of a project", () => {
  it("reads the branch from a repository, a subfolder, a linked worktree and a detached HEAD", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-git-head-")));
    try {
      const repo = path.join(root, "repo"); fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
      git(repo, "init", "-q"); git(repo, "commit", "-q", "--allow-empty", "-m", "first");
      assert.deepEqual(readGitHead(repo), { name: "main", detached: false });
      assert.deepEqual(readGitHead(path.join(repo, "src", "deep")), { name: "main", detached: false });

      git(repo, "checkout", "-q", "-b", "feature/branch-ui");
      assert.deepEqual(readGitHead(repo), { name: "feature/branch-ui", detached: false });

      const linked = path.join(root, "linked");
      git(repo, "worktree", "add", "-q", "-b", "fix/other", linked);
      assert.deepEqual(readGitHead(linked), { name: "fix/other", detached: false });
      assert.deepEqual(readGitHead(repo), { name: "feature/branch-ui", detached: false });

      const sha = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "--detach");
      assert.deepEqual(readGitHead(repo), { name: sha.slice(0, 7), detached: true });

      const plain = path.join(root, "plain"); fs.mkdirSync(plain);
      fs.writeFileSync(path.join(plain, ".git"), "not a gitdir pointer\n");
      assert.equal(readGitHead(plain), null);
      assert.equal(readGitHead(""), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("puts the branch on catalog rows and changes the revision when the branch changes", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-git-head-catalog-")));
    try {
      const repo = path.join(root, "repo"), plain = path.join(root, "plain");
      fs.mkdirSync(repo); fs.mkdirSync(plain);
      git(repo, "init", "-q"); git(repo, "commit", "-q", "--allow-empty", "-m", "first");
      const infos = [info(path.join(root, "a.jsonl"), repo), info(path.join(root, "b.jsonl"), repo), info(path.join(root, "c.jsonl"), plain)];
      const key = Buffer.alloc(32, 3);
      const build = () => buildSessionCatalog({ gatewayInstanceRef: "gateway_git_head", key, listSessions: async () => infos });
      const first = await build();
      const inRepo = first.sessions.filter((row) => row.projectLabel === "repo"), outside = first.sessions.find((row) => row.projectLabel === "plain");
      assert.deepEqual(inRepo.map((row) => row.gitBranch), [{ name: "main", detached: false }, { name: "main", detached: false }]);
      assert.equal("gitBranch" in outside, false);
      const result = validateFixture(createWebUiSchemaRegistry(), "session-catalog-v1", first);
      assert.equal(result.valid, true, String(result.errors));

      git(repo, "checkout", "-q", "-b", "next");
      const second = await build(), moved = second.sessions.find((row) => row.sessionRef === inRepo[0].sessionRef);
      assert.deepEqual(moved.gitBranch, { name: "next", detached: false });
      assert.notEqual(moved.sessionRevision, inRepo[0].sessionRevision);
      assert.notEqual(second.catalogRevision, first.catalogRevision);

    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
