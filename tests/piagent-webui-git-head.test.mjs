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

describe("Piagent Gateway Git branch switch", () => {
  it("lists local and remote branches, switches, creates, tracks a remote branch and keeps Git's refusals", async () => {
    const { listBranches, switchBranch } = await import("../packages/piagent-webui/gateway/git-branches.ts");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-git-branches-")));
    try {
      const origin = path.join(root, "origin"), repo = path.join(root, "repo");
      fs.mkdirSync(origin); git(origin, "init", "-q");
      fs.writeFileSync(path.join(origin, "a.txt"), "one\n"); git(origin, "add", "a.txt"); git(origin, "commit", "-q", "-m", "first");
      git(origin, "checkout", "-q", "-b", "feature/remote-only"); git(origin, "commit", "-q", "--allow-empty", "-m", "remote work");
      git(origin, "checkout", "-q", "main");
      execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
      git(repo, "branch", "local-only");

      let list = await listBranches(repo);
      assert.equal(list.repository, true);
      assert.deepEqual(list.head, { name: "main", detached: false });
      assert.deepEqual(list.branches.filter((item) => !item.remote).map((item) => [item.name, item.current]).sort(),
        [["local-only", false], ["main", true]]);
      assert.deepEqual(list.branches.filter((item) => item.remote).map((item) => `${item.remote}/${item.name}`), ["origin/feature/remote-only"],
        "a remote branch shows only when no local branch has its name");
      assert.equal(list.changedFiles, 0);

      assert.deepEqual(await switchBranch(repo, { branch: "local-only" }), { name: "local-only", detached: false });
      assert.deepEqual(await switchBranch(repo, { branch: "feature/new-ui", create: true }), { name: "feature/new-ui", detached: false });
      assert.deepEqual(await switchBranch(repo, { branch: "feature/remote-only", remote: "origin" }), { name: "feature/remote-only", detached: false });
      assert.match(git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), /^origin\/feature\/remote-only$/);

      await assert.rejects(switchBranch(repo, { branch: "main", create: true }), (error) => error.message === "branch-exists");
      await assert.rejects(switchBranch(repo, { branch: "--orphan" }), (error) => error.message === "branch-name-invalid");
      await assert.rejects(switchBranch(repo, { branch: "bad..name", create: true }), (error) => error.message === "branch-name-invalid");
      await assert.rejects(switchBranch(repo, { branch: "nowhere" }), (error) => error.message === "branch-not-found");

      // A change Git would overwrite stops the switch, with Git's own words.
      git(repo, "checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "a.txt"), "on main\n"); git(repo, "commit", "-q", "-am", "main edit");
      git(repo, "checkout", "-q", "local-only");
      fs.writeFileSync(path.join(repo, "a.txt"), "uncommitted\n");
      list = await listBranches(repo);
      assert.equal(list.changedFiles, 1);
      await assert.rejects(switchBranch(repo, { branch: "main" }), (error) => error.message === "branch-switch-local-changes"
        && /would be overwritten/.test(error.detail ?? ""));
      assert.deepEqual(list.head, { name: "local-only", detached: false });
      assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "uncommitted\n", "the member's change is untouched");

      const plain = path.join(root, "plain"); fs.mkdirSync(plain);
      assert.equal(await listBranches(plain), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Piagent Gateway folders that hold several repositories", () => {
  it("finds the repositories one level down, with their branches, and lists them on catalog rows", async () => {
    const { childRepositories, childRepositoryFolder } = await import("../packages/piagent-webui/gateway/git-repositories.ts");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-child-repos-")));
    try {
      const working = path.join(root, "Working");
      for (const name of ["FE", "docs", ".hidden", "node_modules/pkg"]) fs.mkdirSync(path.join(working, name), { recursive: true });
      const fe = path.join(working, "FE");
      git(fe, "init", "-q"); git(fe, "commit", "-q", "--allow-empty", "-m", "first"); git(fe, "checkout", "-q", "-b", "feature/login");
      git(fe, "worktree", "add", "-q", "-b", "develop", path.join(working, "BE"));
      git(path.join(working, ".hidden"), "init", "-q");
      git(path.join(working, "node_modules"), "init", "-q");
      assert.deepEqual(childRepositories(working), [
        { name: "BE", path: "BE", head: { name: "develop", detached: false } },
        { name: "FE", path: "FE", head: { name: "feature/login", detached: false } }]);
      assert.deepEqual(childRepositories(fe), [], "a folder inside a repository is that repository");
      assert.equal(childRepositoryFolder(working, "FE"), fe);
      for (const bad of ["docs", "../Working/FE", "FE/..", ".hidden", "node_modules", ""]) assert.equal(childRepositoryFolder(working, bad), null, bad);

      const at = new Date("2026-10-08T01:00:00Z");
      const info = (file, cwd) => ({ path: file, id: path.basename(file), cwd, created: at, modified: at, messageCount: 1, firstMessage: "hi", allMessagesText: "hi" });
      const catalog = await buildSessionCatalog({ gatewayInstanceRef: "gateway_child_repos", key: Buffer.alloc(32, 4),
        listSessions: async () => [info(path.join(root, "a.jsonl"), working), info(path.join(root, "b.jsonl"), fe)] });
      const workspace = catalog.sessions.find((row) => row.projectLabel === "Working"), single = catalog.sessions.find((row) => row.projectLabel === "FE");
      assert.equal("gitBranch" in workspace, false);
      assert.deepEqual(workspace.gitRepositories, [{ name: "BE", branch: { name: "develop", detached: false } }, { name: "FE", branch: { name: "feature/login", detached: false } }]);
      assert.equal("gitRepositories" in single, false, "a repository shows its branch, not its children");
      const result = validateFixture(createWebUiSchemaRegistry(), "session-catalog-v1", catalog);
      assert.equal(result.valid, true, String(result.errors));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
