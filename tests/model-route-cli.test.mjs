import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const roots = new Set();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-route-cli-")); roots.add(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "src")); fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env bash
if [[ " $* " == *" --version "* ]]; then echo 0.82.0; exit 0; fi
printf '%s\n' 'provider      model          context  max-out  thinking  images'
printf '%s\n' 'openai-codex  gpt-5.6-luna   200K     64K      yes       yes'
printf '%s\n' 'openai-codex  gpt-5.6-terra  200K     64K      yes       yes'
printf '%s\n' 'openai-codex  gpt-5.6-sol    200K     64K      yes       yes'
`, { mode: 0o755 });
  return { root, bin };
}

describe("piagent-route prelaunch adapter", () => {
  it("uses only the authenticated Pi catalog and emits no raw task text", () => {
    const { root, bin } = fixture();
    const prompt = "Fix src/a.ts and run npm test";
    const result = spawnSync(process.execPath, [path.resolve("scripts/pi-model-route.mjs"), "--prompt", prompt, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.promptStored, false);
    assert.equal(JSON.stringify(report).includes(prompt), false);
    assert.equal(report.decision.modelId, "gpt-5.6-luna");
    assert.equal(report.decision.enforced, false);
  });

  it("requires explicit confirmation before starting a provider-backed task", () => {
    const { root, bin } = fixture();
    const result = spawnSync(process.execPath, [path.resolve("scripts/pi-model-route.mjs"), "--prompt", "Fix src/a.ts", "--execute"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires --yes/);
  });

  it("preserves an explicit pin instead of executing a downshift", () => {
    const { root, bin } = fixture();
    const result = spawnSync(process.execPath, [path.resolve("scripts/pi-model-route.mjs"), "--prompt", "Fix src/a.ts", "--execute", "--yes", "--pinned"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /explicit-user-pin-preserved|preserved/);
  });

  it("loads the governed profile path and blocks a protected target before Pi starts", () => {
    const { root, bin } = fixture();
    fs.mkdirSync(path.join(root, ".pi"));
    fs.writeFileSync(path.join(root, ".pi", "piagent-profile.json"), JSON.stringify({
      schemaVersion: 1,
      projectId: "route-fixture",
      mode: "generic",
      protectedPaths: ["secrets/**"],
      verifyCommands: { source: ["npm test"] }
    }));
    const result = spawnSync(process.execPath, [path.resolve("scripts/pi-model-route.mjs"), "--prompt", "Update secrets/config.ts", "--execute", "--yes"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /protected-target|model-routing-cannot-bypass-preflight|abstained/);
  });
});
