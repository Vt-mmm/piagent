import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPrompt(name) {
  return fs.readFileSync(path.join(repoRoot, "packages", "piagent-core", "prompts", `${name}.md`), "utf8");
}

describe("git workflow prompts", () => {
  it("/commit is a guarded local-only commit workflow", () => {
    const prompt = readPrompt("commit");

    assert.match(prompt, /description: Create a guarded local Git commit/);
    assert.match(prompt, /local commit only/i);
    assert.match(prompt, /Do not push, tag, publish, release, merge, or open external provider flows/);
    assert.match(prompt, /git status --short/);
    assert.match(prompt, /git diff --stat/);
    assert.match(prompt, /git add \./);
    assert.match(prompt, /git add -A/);
    assert.match(prompt, /git add --all/);
    assert.match(prompt, /git add -- \./);
    assert.match(prompt, /git add :\//);
    assert.match(prompt, /explicitly confirms/);
    assert.match(prompt, /\.env/);
    assert.match(prompt, /auth\.json/);
    assert.match(prompt, /git diff --check/);
  });

  it("/pr confirms external GitHub writes before push or PR creation", () => {
    const prompt = readPrompt("pr");

    assert.match(prompt, /description: Prepare a guarded pull request/);
    assert.match(prompt, /Do not merge/);
    assert.match(prompt, /git branch --show-current/);
    assert.match(prompt, /git remote -v/);
    assert.match(prompt, /ask for explicit operator confirmation before `git push -u origin <branch>`/);
    assert.match(prompt, /only after the operator explicitly confirms the external GitHub action/);
    assert.match(prompt, /gh pr create --draft/);
    assert.match(prompt, /ready-for-review PR/);
    assert.match(prompt, /Keep secrets and local trust files out of the PR body/);
  });
});
