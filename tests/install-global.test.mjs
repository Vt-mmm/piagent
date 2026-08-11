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
// --stable reads the release tag out of this repository's own package.json, so
// assertions about it have to follow the version instead of pinning it. Tags
// passed as explicit arguments further down are fixtures and stay literal.
const rootManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const releaseTag = `v${rootManifest.version}`;
const expectedPiHostVersion = rootManifest.peerDependencies["@earendil-works/pi-coding-agent"];
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
  # The installer asks for the plain ref and its peeled form in one call, so the
  # plain ref is matched first and answers for both. Any tag resolves, so a
  # version bump does not have to be mirrored here.
  for arg in "$@"; do
    if [[ "$arg" == refs/tags/*-annotated ]]; then
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\t%s\\n' "$arg"
      printf '${annotatedCommit}\\t%s^{}\\n' "$arg"
      exit 0
    fi
    if [[ "$arg" == refs/tags/* ]]; then
      printf '${resolvedCommit}\\t%s\\n' "$arg"
      exit 0
    fi
  done
  exit 0
fi
exit 2
`);
  fs.writeFileSync(pi, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "\${PI_INSTALL_FAKE_PI_VERSION:-${expectedPiHostVersion}}"
  exit 0
fi
if [[ "\${1:-}" == "list" ]]; then
  if [[ -n "\${PI_INSTALL_FAKE_PI_LIST:-}" ]]; then
    printf '%b' "\${PI_INSTALL_FAKE_PI_LIST}"
  else
    printf 'pi %s\\n' "$*"
  fi
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
    assert.ok(result.stdout.includes(`currentRelease: ${releaseTag} (helper package version)`), result.stdout);
    assert.match(result.stdout, /runtime: .+/);
    assert.ok(result.stdout.includes(`tag: ${releaseTag}`), result.stdout);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${resolvedCommit}`));
    assert.match(result.stdout, new RegExp(`source: git:github.com/Vt-mmm/piagent@${resolvedCommit}`));
    assert.match(result.stdout, new RegExp(`\\+ pi install git:github.com/Vt-mmm/piagent@${resolvedCommit}`));
  });

  it("passes the gpt-5.5 high default through install and setup", () => {
    const installer = runInstaller([
      "--stable", "--dry-run", "--no-mcp", "--no-subagents", "--no-web-access"
    ]);
    assert.equal(installer.status, 0, installer.stderr);
    assert.match(installer.stdout, /configure-model-scope\.sh --preset full --default-model openai-codex\/gpt-5\.5:high/);
    assert.doesNotMatch(installer.stdout, /default-model openai-codex\/gpt-5\.5:xhigh/);

    const setup = runSetup([
      "--global-only", "--dry-run", "--no-mcp", "--no-subagents", "--no-web-access", "--no-herdr"
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /--default-model openai-codex\/gpt-5\.5:high/);
    assert.doesNotMatch(setup.stdout, /default-model openai-codex\/gpt-5\.5:xhigh/);
  });

  it("resolves exact version tags when requested", () => {
    const result = runInstaller(["--version", "v1.0.2", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /channel: exact/);
    assert.match(result.stdout, /tag: v1\.0\.2/);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${resolvedCommit}`));
  });

  it("uses annotated tag dereference when available", () => {
    const result = runInstaller(["--version", "v1.0.2-annotated", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`resolvedCommit: ${annotatedCommit}`));
    assert.match(result.stdout, new RegExp(`source: git:github.com/Vt-mmm/piagent@${annotatedCommit}`));
  });

  it("fails closed when stable tag cannot be resolved", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], { PI_INSTALL_FAKE_GIT_MODE: "missing" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`could not resolve release tag ${releaseTag}`), result.stderr);
    assert.doesNotMatch(result.stdout, /\+ pi install/);
  });

  it("derives the stable tag from package metadata instead of an environment override", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
      PIAGENT_CURRENT_RELEASE_TAG: "v9.9.9-missing"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`currentRelease: ${releaseTag}`), result.stdout);
    assert.ok(result.stdout.includes(`tag: ${releaseTag}`), result.stdout);
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
      assert.match(result.stderr, new RegExp(`Pi Coding Agent ${expectedPiHostVersion.replaceAll(".", "\\.")} is required`));
      assert.doesNotMatch(result.stdout, /\+ pi install/);
    }
  });

  it("setup upgrades an old Pi host or fails when auto-install is disabled", () => {
    const common = [
      "--global-only",
      "--package-source", "git:github.com/Vt-mmm/piagent@v1.0.2",
      "--dry-run",
      "--no-mcp",
      "--no-subagents",
      "--no-herdr",
      "--no-model-scope"
    ];
    const upgrade = runSetup(common, { PI_INSTALL_FAKE_PI_VERSION: "0.80.10" });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.ok(upgrade.stdout.includes(`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${expectedPiHostVersion}`));

    const disabled = runSetup([...common, "--no-install-pi"], { PI_INSTALL_FAKE_PI_VERSION: "0.80.10" });
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, new RegExp(`Pi Coding Agent ${expectedPiHostVersion.replaceAll(".", "\\.")} is required`));
  });

  it("rejects --resolve-tag outside stable or exact version channels", () => {
    const dev = runInstaller(["--dev", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    const local = runInstaller(["--local", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    const custom = runInstaller(["--package-source", "git:github.com/Vt-mmm/piagent@v1.0.2", "--resolve-tag", "--dry-run", "--no-model-scope"]);
    assert.equal(dev.status, 2);
    assert.match(dev.stderr, /cannot be used with the floating dev\/latest channel/);
    assert.equal(local.status, 2);
    assert.match(local.stderr, /cannot be used with the local channel/);
    assert.equal(custom.status, 2);
    assert.match(custom.stderr, /only works with --stable or --version/);
  });

  it("rejects every second CLI package selector before install", () => {
    const selectors = [
      { name: "package-source", args: ["--package-source", "git:github.com/Vt-mmm/piagent@v1.0.2"] },
      { name: "channel", args: ["--channel", "stable"] },
      { name: "stable", args: ["--stable"] },
      { name: "dev", args: ["--dev"] },
      { name: "local", args: ["--local"] },
      { name: "version", args: ["--version", "v1.0.2"] },
      { name: "tag", args: ["--tag", "v1.0.2"] }
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

    const exact = runInstaller(["--version", "v1.0.2", "--dry-run", "--no-model-scope"], {
      PIAGENT_RELEASE_CHANNEL: "dev"
    });
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /channel: exact/);
    assert.match(exact.stdout, /source: git:github.com\/Vt-mmm\/piagent@v1\.0\.2/);
  });

  it("fails closed on missing option values", () => {
    const packageSource = runInstaller(["--package-source"]);
    const mcpPreset = runInstaller(["--mcp-preset"]);
    assert.equal(packageSource.status, 2);
    assert.match(packageSource.stderr, /Missing value for --package-source/);
    assert.equal(mcpPreset.status, 2);
    assert.match(mcpPreset.stderr, /Missing value for --mcp-preset/);
  });

  // The two documented entry points used to disagree: piagent-setup installed
  // MCP by default and piagent-install did not, so following the team document
  // produced a machine with no MCP and a next-steps block advertising /mcp.
  it("installs the MCP baseline by default and only advertises it when installed", () => {
    const withDefault = runInstaller(["--stable", "--dry-run", "--no-model-scope"]);
    assert.equal(withDefault.status, 0, withDefault.stderr);
    assert.match(withDefault.stdout, /pi install npm:pi-mcp-adapter@/);
    assert.match(withDefault.stdout, /mcp-manage\.mjs --scope global --preset core --replace/);
    assert.match(withDefault.stdout, /\/mcp {2,}# inspect MCP servers/);

    const skipped = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--no-mcp"]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.doesNotMatch(skipped.stdout, /pi-mcp-adapter/);
    assert.doesNotMatch(skipped.stdout, /mcp-manage\.mjs/);
    assert.doesNotMatch(skipped.stdout, /\/mcp {2,}# inspect MCP servers/);
  });

  // setup only ever appended --with-mcp, relying on the installer defaulting MCP
  // off. Once the installer defaulted it on, saying nothing meant installing it,
  // so --no-mcp reached the installer as silence and the operator's explicit
  // choice was overridden by the default it was meant to override.
  it("passes the MCP opt-out through setup instead of relying on an installer default", () => {
    const common = ["--global-only", "--dry-run", "--no-subagents", "--no-herdr", "--no-model-scope"];

    // setup only prints the installer command it would run, so what this layer
    // has to get right is the flag it hands over. Whether that flag then skips
    // the adapter is the installer's own test above.
    const skipped = runSetup([...common, "--no-mcp"]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.ok(skipped.stdout.includes("install-global.sh"), skipped.stdout);
    assert.ok(skipped.stdout.includes("--no-mcp"), skipped.stdout);
    assert.ok(!skipped.stdout.includes("--with-mcp"), skipped.stdout);

    const included = runSetup(common);
    assert.equal(included.status, 0, included.stderr);
    assert.ok(included.stdout.includes("--with-mcp --mcp-preset core"), included.stdout);
    assert.ok(!included.stdout.includes("--no-mcp"), included.stdout);
  });

  it("passes the subagents opt-out through setup instead of preserving an existing install", () => {
    const skipped = runSetup([
      "--global-only",
      "--dry-run",
      "--no-mcp",
      "--no-subagents",
      "--no-herdr",
      "--no-model-scope"
    ]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.ok(skipped.stdout.includes("--no-subagents"), skipped.stdout);
    assert.ok(!skipped.stdout.includes("--with-subagents"), skipped.stdout);

    const included = runSetup([
      "--global-only",
      "--dry-run",
      "--no-mcp",
      "--with-subagents",
      "--no-herdr",
      "--no-model-scope"
    ]);
    assert.equal(included.status, 0, included.stderr);
    assert.ok(included.stdout.includes("--with-subagents --subagents-preset safe"), included.stdout);
    assert.ok(!included.stdout.includes("--no-subagents"), included.stdout);
  });

  // The preset used to be read only at the last step, after the platform package
  // and the MCP adapter had already been installed, so a typo failed with a
  // half-configured machine behind it.
  it("rejects an unknown preset before installing anything", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--mcp-preset", "nonsense"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /unknown preset: nonsense/);
    assert.match(result.stderr, /Nothing was installed/);
    assert.doesNotMatch(result.stdout, /pi install/);

    const good = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--mcp-preset", "core"]);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /pi install npm:pi-mcp-adapter@/);
  });

  // Validating the preset early put a Node script ahead of the Node check, so on a
  // machine without Node the installer blamed the preset for a missing interpreter.
  it("reports a missing Node runtime rather than blaming the preset", () => {
    const fakeBin = makeFakeBin();
    const withoutNode = spawnSync("bash", ["scripts/install-global.sh", "--stable", "--dry-run", "--no-model-scope", "--mcp-preset", "core"], {
      cwd: repositoryRoot,
      env: { ...process.env, PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter) },
      encoding: "utf8"
    });
    assert.equal(spawnSync("bash", ["-c", "command -v node"], {
      env: { PATH: "/usr/bin:/bin" }
    }).status !== 0, true, "the test needs a PATH with no Node on it");
    assert.match(withoutNode.stderr, /Node\.js >=/);
    assert.doesNotMatch(withoutNode.stderr, /preset/);
  });

  // setup never forwards --mcp-preset alongside --no-mcp, so the installer's own
  // check for that pair never sees it and the preset vanished without a word.
  it("rejects the same contradictory pair from setup", () => {
    const result = runSetup(["--global-only", "--dry-run", "--no-mcp", "--mcp-preset", "popular"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /--mcp-preset has no effect with --no-mcp/);
    assert.doesNotMatch(result.stdout, /install-global\.sh/);
  });

  // A preset that is accepted and then dropped reads as a preset that was applied.
  it("refuses a preset that cannot take effect", () => {
    const conflict = runInstaller(["--stable", "--dry-run", "--no-mcp", "--mcp-preset", "popular"]);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /--mcp-preset has no effect with --no-mcp/);
  });

  it("keeps dev channel floating and explicit", () => {
    const result = runInstaller(["--dev", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /floating dev\/latest source/);
    assert.match(result.stdout, /channel: dev/);
    assert.match(result.stdout, /source: git:github.com\/Vt-mmm\/piagent/);
    assert.doesNotMatch(result.stdout, /resolvedCommit:/);
  });

  it("removes an older local checkout registration before installing a release", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    const localPlatform = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    const otherLocalPackage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    temporaryRoots.add(agentDir);
    temporaryRoots.add(localPlatform);
    temporaryRoots.add(otherLocalPackage);
    fs.writeFileSync(path.join(localPlatform, "package.json"), '{"name":"@piagent/platform","version":"0.0.0"}\n');
    fs.writeFileSync(path.join(otherLocalPackage, "package.json"), '{"name":"@example/other","version":"0.0.0"}\n');

    const localPlatformSource = path.relative(agentDir, localPlatform);
    const otherLocalSource = path.relative(agentDir, otherLocalPackage);
    const previousGitSource = "git:github.com/Vt-mmm/piagent@1111111111111111111111111111111111111111";
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--no-mcp"], {
      PI_CODING_AGENT_DIR: agentDir,
      PI_INSTALL_FAKE_PI_LIST: [
        "User packages:",
        `  ${localPlatformSource}`,
        `    ${localPlatform}`,
        `  ${otherLocalSource}`,
        `    ${otherLocalPackage}`,
        `  ${previousGitSource}`,
        "    /tmp/piagent-release",
        "Project packages:",
        "  ../",
        ""
      ].join("\\n")
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\+ pi remove ${localPlatform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(result.stdout, new RegExp(`\\+ pi remove ${localPlatformSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /\+ pi remove git:github\.com\/Vt-mmm\/piagent@1111111111111111111111111111111111111111/);
    assert.doesNotMatch(result.stdout, new RegExp(`\\+ pi remove ${otherLocalSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, new RegExp(`\\+ pi install git:github.com/Vt-mmm/piagent@${resolvedCommit}`));
  });

  it("refreshes owned add-ons and preserves an existing subagents install", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"], {
      PI_INSTALL_FAKE_PI_LIST: [
        "User packages:",
        "  npm:pi-mcp-adapter@2.11.0",
        "    /tmp/pi-mcp-adapter",
        "  npm:pi-subagents@0.35.1",
        "    /tmp/pi-subagents",
        "  npm:pi-web-access@0.13.0",
        "    /tmp/pi-web-access",
        "Project packages:",
        ""
      ].join("\\n")
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+ pi remove npm:pi-mcp-adapter@2\.11\.0/);
    assert.match(result.stdout, /\+ pi install npm:pi-mcp-adapter@2\.15\.0/);
    assert.match(result.stdout, /\+ pi remove npm:pi-subagents@0\.35\.1/);
    assert.match(result.stdout, /\+ pi install npm:pi-subagents@0\.38\.0/);
    assert.match(result.stdout, /\+ pi remove npm:pi-web-access@0\.13\.0/);
    assert.match(result.stdout, /\+ pi install npm:pi-web-access@0\.17\.0/);
  });

  it("does not add subagents to a clean install unless requested", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /pi install npm:pi-subagents/);
  });

  it("installs web access by default and honors explicit opt-out", () => {
    const included = runInstaller(["--stable", "--dry-run", "--no-model-scope"]);
    assert.equal(included.status, 0, included.stderr);
    assert.match(included.stdout, /\+ pi install npm:pi-web-access@0\.17\.0/);

    const skipped = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--no-web-access"], {
      PI_INSTALL_FAKE_PI_LIST: [
        "User packages:",
        "  npm:pi-web-access@0.13.0",
        "    /tmp/pi-web-access",
        "Project packages:",
        ""
      ].join("\\n")
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.doesNotMatch(skipped.stdout, /pi (?:remove|install) npm:pi-web-access/);
  });

  it("honors an explicit request to leave an existing subagents install alone", () => {
    const result = runInstaller(["--stable", "--dry-run", "--no-model-scope", "--no-subagents"], {
      PI_INSTALL_FAKE_PI_LIST: [
        "User packages:",
        "  npm:pi-subagents@0.35.1",
        "    /tmp/pi-subagents",
        "Project packages:",
        ""
      ].join("\\n")
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /pi (?:remove|install) npm:pi-subagents/);
  });

  it("passes the web access opt-out through setup", () => {
    const skipped = runSetup([
      "--global-only",
      "--dry-run",
      "--no-mcp",
      "--no-subagents",
      "--no-web-access",
      "--no-herdr",
      "--no-model-scope"
    ]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.ok(skipped.stdout.includes("--no-web-access"), skipped.stdout);
    assert.ok(!skipped.stdout.includes("--with-web-access"), skipped.stdout);

    const included = runSetup([
      "--global-only",
      "--dry-run",
      "--no-mcp",
      "--no-subagents",
      "--no-herdr",
      "--no-model-scope"
    ]);
    assert.equal(included.status, 0, included.stderr);
    assert.ok(included.stdout.includes("--with-web-access"), included.stdout);
    assert.ok(!included.stdout.includes("--no-web-access"), included.stdout);
  });
});

describe("setup package source default", () => {
  // Project .pi/settings.json is meant to be committed, so whatever setup puts
  // in it has to mean the same thing on someone else's machine.
  function installedCopy() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    temporaryRoots.add(root);
    const platform = path.join(root, "node_modules", "@piagent", "platform");
    fs.mkdirSync(platform, { recursive: true });
    // A dry run reads the manifest and prints the commands it would run, so the
    // manifest and scripts are all an installed copy needs here.
    fs.cpSync(path.join(repositoryRoot, "package.json"), path.join(platform, "package.json"));
    fs.cpSync(path.join(repositoryRoot, "scripts"), path.join(platform, "scripts"), { recursive: true });
    return platform;
  }

  it("uses a registry source when running from an installed package", () => {
    const platform = installedCopy();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    temporaryRoots.add(project);
    const result = spawnSync("bash", [path.join(platform, "scripts", "setup.sh"), project, "--dry-run", "--no-model-scope", "--profile", "generic"], {
      env: { ...process.env, PATH: `${makeFakeBin()}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8"
    });

    const version = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`packageSource: npm:@piagent/platform@${version}`), result.stdout);
    // An install path is correct for nobody but the machine that produced it.
    assert.doesNotMatch(result.stdout, /packageSource: \//);
    assert.doesNotMatch(result.stderr, /No exact package source provided/);
  });

  it("still warns when running from a working checkout", () => {
    // A checkout has no published identity to point at, so the local path is
    // the honest answer there, and it has to say so.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    temporaryRoots.add(project);
    const result = runSetup([project, "--dry-run", "--no-model-scope", "--profile", "generic"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No exact package source provided/);
    assert.match(result.stdout, new RegExp(`packageSource: ${repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  // piagent-init is the second way a project gets its settings written, so it
  // has to reach the same answer. A portable source through one entry point and
  // an install path through the other is the same defect, just harder to find.
  it("writes the same registry source through piagent-init", () => {
    const platform = installedCopy();
    for (const directory of ["adapters", "catalog", "packs", "schemas", "templates", "packages", "evals"]) {
      const source = path.join(repositoryRoot, directory);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(platform, directory), { recursive: true });
    }
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-bin-"));
    temporaryRoots.add(project);
    fs.writeFileSync(path.join(project, "package.json"), '{"name":"demo"}\n');

    const result = spawnSync("bash", [path.join(platform, "scripts", "init-project.sh"), project, "--profile", "generic"], {
      env: { ...process.env, PATH: `${makeFakeBin()}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);

    const version = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
    const settings = JSON.parse(fs.readFileSync(path.join(project, ".pi", "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, [`npm:@piagent/platform@${version}`]);
    assert.doesNotMatch(result.stderr, /No exact package source provided/);
  });
});
