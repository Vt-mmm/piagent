import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolvedCommit = "ef7883a2c3ffa3129047db61528230ab2c32bd99";
const annotatedCommit = "3e7df37915b06575ec347b714669ec48fec8215d";
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-install-bin-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeFakeBin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
  temporaryRoots.add(root);
  const git = path.join(root, "git");
  const pi = path.join(root, "pi");
  fs.writeFileSync(git, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${PI_INSTALL_FAKE_GIT_MODE:-}" == "missing" ]]; then
  exit 0
fi
if [[ "$1" == "ls-remote" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "refs/tags/v0.4.8" ]]; then
      printf '${resolvedCommit}\\trefs/tags/v0.4.8\\n'
      exit 0
    fi
    if [[ "$arg" == "refs/tags/v0.4.8^{}" ]]; then
      printf '${resolvedCommit}\\trefs/tags/v0.4.8^{}\\n'
      exit 0
    fi
    if [[ "$arg" == "refs/tags/v0.4.8-annotated" ]]; then
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/tags/v0.4.8-annotated\\n'
      printf '${annotatedCommit}\\trefs/tags/v0.4.8-annotated^{}\\n'
      exit 0
    fi
    if [[ "$arg" == "refs/tags/v0.4.8-annotated^{}" ]]; then
      printf '${annotatedCommit}\\trefs/tags/v0.4.8-annotated^{}\\n'
      exit 0
    fi
  done
  exit 0
fi
exit 2
`);
  fs.writeFileSync(pi, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${PI_INSTALL_FAKE_PI_VERSION:-0.81.1}"
  exit 0
fi
printf 'pi %s\\n' "$*"
`);
  fs.chmodSync(git, 0o755);
  fs.chmodSync(pi, 0o755);
  return root;
}

function runInstaller(args, env = {}) {
  const fakeBin = makeFakeBin();
  return spawnSync("bash", ["scripts/install-global.sh", ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    encoding: "utf8"
  });
}

function runSetup(args, env = {}) {
  const fakeBin = makeFakeBin();
  return spawnSync("bash", ["scripts/setup.sh", ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    encoding: "utf8"
  });
}

describe("install-global release channels", () => {
  it("resolves stable tag to a commit SHA before install", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /channel: stable/);
    assert.match(result.stdout, /currentRelease: v0\.4\.8 \(helper package version\)/);
    assert.match(result.stdout, /runtime: .+/);
    assert.match(result.stdout, /tag: v0\.4\.8/);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${resolvedCommit}`));
    assert.match(result.stdout, new RegExp(`source: git:github.com/Vt-mmm/piagent@${resolvedCommit}`));
    assert.match(result.stdout, new RegExp(`\\+ pi install git:github.com/Vt-mmm/piagent@${resolvedCommit}`));
  });

  it("resolves exact version tags when requested", () => {
    const result = runInstaller(["--version", "v0.4.8", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /channel: exact/);
    assert.match(result.stdout, /tag: v0\.4\.8/);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${resolvedCommit}`));
  });

  it("uses annotated tag dereference when available", () => {
    const result = runInstaller(["--version", "v0.4.8-annotated", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${annotatedCommit}`));
    assert.match(result.stdout, new RegExp(`source: git:github.com/Vt-mmm/piagent@${annotatedCommit}`));
  });

  it("fails closed when stable tag cannot be resolved", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], { PI_INSTALL_FAKE_GIT_MODE: "missing" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not resolve release tag v0\.4\.8/);
    assert.doesNotMatch(result.stdout, /\+ pi install/);
  });

  it("derives the stable tag from package metadata instead of an environment override", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
      PIAGENT_CURRENT_RELEASE_TAG: "v9.9.9-missing"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /currentRelease: v0\.4\.8/);
    assert.match(result.stdout, /tag: v0\.4\.8/);
  });

  it("can require stable resolution to match the release commit", () => {
    const matching = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
      PIAGENT_EXPECTED_RELEASE_COMMIT: resolvedCommit
    });
    assert.equal(matching.status, 0, matching.stderr);

    const mismatch = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
      PIAGENT_EXPECTED_RELEASE_COMMIT: "1111111111111111111111111111111111111111"
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /resolved commit does not match the required release commit/);
    assert.doesNotMatch(mismatch.stdout, /\+ pi install/);
  });

  it("fails closed when the installed Pi host version is unsupported", () => {
    for (const version of ["0.80.10", "unexpected-output"]) {
      const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
        PI_INSTALL_FAKE_PI_VERSION: version
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Pi Coding Agent 0\.81\.1 is required/);
      assert.doesNotMatch(result.stdout, /\+ pi install/);
    }
  });

  it("setup upgrades an old Pi host or fails when auto-install is disabled", () => {
    const common = [
      "--global-only",
      "--package-source", "git:github.com/Vt-mmm/piagent@v0.4.8",
      "--dry-run",
      "--no-mcp",
      "--no-subagents",
      "--no-herdr",
      "--no-model-scope"
    ];
    const upgrade = runSetup(common, { PI_INSTALL_FAKE_PI_VERSION: "0.80.10" });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(upgrade.stdout, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent@0\.81\.1/);

    const disabled = runSetup([...common, "--no-install-pi"], { PI_INSTALL_FAKE_PI_VERSION: "0.80.10" });
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, /Pi Coding Agent 0\.81\.1 is required/);
  });

  it("rejects --resolve-tag outside stable or exact version channels", () => {
    const dev = runInstaller(["--dev", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    const local = runInstaller(["--local", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    const custom = runInstaller(["--package-source", "git:github.com/Vt-mmm/piagent@v0.4.8", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(dev.status, 2);
    assert.match(dev.stderr, /cannot be used with the floating dev\/latest channel/);
    assert.equal(local.status, 2);
    assert.match(local.stderr, /cannot be used with the local channel/);
    assert.equal(custom.status, 2);
    assert.match(custom.stderr, /only works with --stable or --version/);
  });

  it("rejects every second CLI package selector before install", () => {
    const selectors = [
      { name: "package-source", args: ["--package-source", "git:github.com/Vt-mmm/piagent@v0.4.8"] },
      { name: "channel", args: ["--channel", "stable"] },
      { name: "stable", args: ["--stable"] },
      { name: "dev", args: ["--dev"] },
      { name: "local", args: ["--local"] },
      { name: "version", args: ["--version", "v0.4.8"] },
      { name: "tag", args: ["--tag", "v0.4.8"] }
    ];

    for (const first of selectors) {
      for (const second of selectors) {
        const result = runInstaller([
          ...first.args,
          ...second.args,
          "--dry-run",
          "--no-model-scope"
        ]);
        assert.equal(
          result.status,
          2,
          `${first.name} followed by ${second.name} should fail:\n${result.stdout}\n${result.stderr}`
        );
        assert.match(result.stderr, /only one CLI package selector is allowed/);
        assert.doesNotMatch(result.stdout, /\+ pi install/);
      }
    }
  });

  it("lets the first CLI package selector override environment defaults once", () => {
    const dev = runInstaller(["--dev", "--dry-run", "--no-model-scope"], {
      PIAGENT_PACKAGE_SOURCE: "git:github.com/Vt-mmm/piagent@v0.4.7",
      PIAGENT_PACKAGE_VERSION: "v0.4.7",
      PIAGENT_RELEASE_CHANNEL: "stable"
    });
    assert.equal(dev.status, 0, dev.stderr);
    assert.match(dev.stdout, /channel: dev/);
    assert.match(dev.stdout, /source: git:github.com\/Vt-mmm\/piagent$/m);

    const exact = runInstaller(["--version", "v0.4.8", "--dry-run", "--no-model-scope"], {
      PIAGENT_RELEASE_CHANNEL: "dev"
    });
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /channel: exact/);
    assert.match(exact.stdout, /source: git:github.com\/Vt-mmm\/piagent@v0\.4\.8/);
  });

  it("fails closed on missing option values", () => {
    const packageSource = runInstaller(["--package-source"]);
    const mcpPreset = runInstaller(["--mcp-preset"]);
    assert.equal(packageSource.status, 2);
    assert.match(packageSource.stderr, /Missing value for --package-source/);
    assert.equal(mcpPreset.status, 2);
    assert.match(mcpPreset.stderr, /Missing value for --mcp-preset/);
  });

  it("keeps dev channel floating and explicit", () => {
    const result = runInstaller(["--dev", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /floating dev\/latest source/);
    assert.match(result.stdout, /channel: dev/);
    assert.match(result.stdout, /source: git:github.com\/Vt-mmm\/piagent/);
    assert.doesNotMatch(result.stdout, /resolvedCommit:/);
  });
});
