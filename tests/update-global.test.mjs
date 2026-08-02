import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();

function restoreFixtureDirectoryPermissions(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    fs.chmodSync(current, 0o700);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
}

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-update-")) continue;
    restoreFixtureDirectoryPermissions(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-")));
  temporaryRoots.add(root);
  return root;
}

// The command replaces the package it is running from, so the mutating paths can
// only be exercised against a copy laid out the way npm lays out a global
// install. Running the real file keeps the test honest about what ships.
function stageGlobalInstall({
  helperVersion = "1.1.0",
  registryVersion = "1.1.4",
  registryHost = "0.82.0",
  registryPeers,
  npmViewVersionResult,
  npmViewPeerDependenciesResult,
  installedHost = "0.81.0",
  helperInstallLands = registryVersion,
  npmViewFails = false,
  npmInstallFails = "",
  defaultPrefixWritable = true,
  activePrefixWritable = true
} = {}) {
  const root = temporaryDirectory();
  const platformRoot = path.join(root, "lib", "node_modules", "@piagent", "platform");
  fs.mkdirSync(path.join(platformRoot, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(repositoryRoot, "scripts/update-global.mjs"),
    path.join(platformRoot, "scripts/update-global.mjs")
  );
  fs.writeFileSync(
    path.join(platformRoot, "package.json"),
    `${JSON.stringify({ name: "@piagent/platform", version: helperVersion }, undefined, 2)}\n`
  );

  const log = path.join(root, "commands.log");
  const bin = path.join(root, "bin");
  const defaultNpmPrefix = defaultPrefixWritable ? root : path.join(root, "readonly-global");
  if (!defaultPrefixWritable) {
    fs.mkdirSync(path.join(defaultNpmPrefix, "lib", "node_modules"), { recursive: true });
    fs.chmodSync(path.join(defaultNpmPrefix, "lib", "node_modules"), 0o555);
  }
  fs.mkdirSync(bin, { recursive: true });

  const peers = registryPeers ?? { "@earendil-works/pi-coding-agent": registryHost };
  const viewVersion = npmViewVersionResult ?? registryVersion;
  const viewPeerDependencies = npmViewPeerDependenciesResult ?? peers;
  fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> ${JSON.stringify(log)}
if [[ "$1" == "config" && "$2" == "get" && "$3" == "prefix" ]]; then
  printf '%s\\n' ${JSON.stringify(defaultNpmPrefix)}
  exit 0
fi
if [[ "$1" == "root" && "$2" == "-g" ]]; then
  prefix=${JSON.stringify(defaultNpmPrefix)}
  previous=""
  for arg in "$@"; do
    if [[ "$previous" == "--prefix" ]]; then prefix="$arg"; fi
    previous="$arg"
  done
  printf '%s/lib/node_modules\\n' "$prefix"
  exit 0
fi
if [[ "$1" == "view" ]]; then
  ${npmViewFails ? "exit 1" : ""}
  case "$3" in
    version) printf '%s' ${JSON.stringify(JSON.stringify(viewVersion))} ;;
    peerDependencies) printf '%s' ${JSON.stringify(JSON.stringify(viewPeerDependencies))} ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$1" == "install" ]]; then
  ${npmInstallFails ? `if [[ "$*" == *${JSON.stringify(npmInstallFails)}* ]]; then exit 1; fi` : ""}
  prefix=${JSON.stringify(defaultNpmPrefix)}
  previous=""
  for arg in "$@"; do
    if [[ "$previous" == "--prefix" ]]; then prefix="$arg"; fi
    previous="$arg"
  done
  # Only the helper install rewrites the on-disk version, the way npm would.
  if [[ "$*" == *"@piagent/platform@"* ]]; then
    target="$prefix/lib/node_modules/@piagent/platform"
    if [[ "$target" != ${JSON.stringify(platformRoot)} ]]; then
      mkdir -p "$target"
      cp -R ${JSON.stringify(platformRoot)}/. "$target"/
    fi
    printf '{\\n  "name": "@piagent/platform",\\n  "version": "%s"\\n}\\n' ${JSON.stringify(helperInstallLands)} > "$target/package.json"
  fi
  exit 0
fi
exit 0
`);
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env bash
${installedHost ? `printf '%s\\n' ${JSON.stringify(installedHost)}` : "exit 1"}
`);
  // Stand-ins for the scripts the update hands off to, so a run can be observed
  // end to end without installing anything.
  for (const script of ["install-global.sh", "team-doctor.sh"]) {
    fs.writeFileSync(path.join(platformRoot, "scripts", script), `#!/usr/bin/env bash
printf '${script} %s\\n' "$*" >> ${JSON.stringify(log)}
exit 0
`);
  }
  fs.writeFileSync(path.join(platformRoot, "scripts", "migrate-project-state.mjs"), `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, \`migrate-project-state.mjs \${process.argv.slice(2).join(" ")}\\n\`);
if (process.argv.includes("--fail")) {
  console.error("migration failed");
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  projectPath: process.argv[2],
  migrated: process.argv.includes("--apply"),
  renamed: process.argv.includes("--apply") ? [{ from: ".pi/company-profile.json", to: ".pi/piagent-profile.json" }] : undefined,
  rewrote: process.argv.includes("--apply") ? ["AGENTS.md"] : undefined,
  removedOld: process.argv.includes("--remove-old") ? [".pi/company-profile.json"] : undefined,
  wouldRename: process.argv.includes("--apply") ? undefined : [{ from: ".pi/company-profile.json", to: ".pi/piagent-profile.json" }],
  wouldRewrite: process.argv.includes("--apply") ? undefined : ["AGENTS.md"],
  skipped: []
}));
`);
  for (const file of ["npm", "pi"]) fs.chmodSync(path.join(bin, file), 0o755);
  if (!activePrefixWritable) fs.chmodSync(path.join(root, "lib", "node_modules"), 0o555);

  return { root, platformRoot, bin, log };
}

function runUpdate(stage, args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(stage.platformRoot, "scripts/update-global.mjs"), ...args], {
    cwd: stage.root,
    env: { ...process.env, HOME: stage.root, ...env, PATH: `${stage.bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    encoding: "utf8"
  });
  const commands = fs.existsSync(stage.log) ? fs.readFileSync(stage.log, "utf8").trim().split("\n").filter(Boolean) : [];
  // `npm view @piagent/platform@1.1.4 ...` carries the same specifier as the
  // install, so anything asserting about installs has to exclude the queries.
  const installs = commands.filter((line) => line.startsWith("npm install") || !line.startsWith("npm "));
  return { ...result, commands, installs };
}

describe("piagent-update", () => {
  it("reports what is available without installing anything", () => {
    const stage = stageGlobalInstall({ helperVersion: "1.1.0", registryVersion: "1.1.4", installedHost: "0.81.0" });
    const result = runUpdate(stage, ["--check"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /helper:\s+1\.1\.0 -> 1\.1\.4/);
    assert.match(result.stdout, /host:\s+0\.81\.0 -> 0\.82\.0/);
    assert.match(result.stdout, /Update available: helper, host/);
    assert.equal(result.commands.some((line) => line.startsWith("npm install")), false, "--check must not install");
  });

  it("says so when there is nothing to update", () => {
    const stage = stageGlobalInstall({ helperVersion: "1.1.4", registryVersion: "1.1.4", installedHost: "0.82.0" });
    const result = runUpdate(stage, ["--check"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Everything is on the target release/);
    assert.match(result.stdout, /already current/);
  });

  it("prints the whole plan under --dry-run and installs nothing", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN: npm install -g --ignore-scripts @earendil-works\/pi-coding-agent@0\.82\.0/);
    assert.match(result.stdout, /DRY RUN: npm install -g --ignore-scripts @piagent\/platform@1\.1\.4/);
    assert.match(result.stdout, /DRY RUN: bash .*install-global\.sh --stable/);
    assert.match(result.stdout, /nothing was installed/);
    assert.equal(result.commands.some((line) => line.startsWith("npm install")), false);
    assert.equal(fs.existsSync(stage.log) && result.commands.some((l) => l.startsWith("install-global.sh")), false);
  });

  it("previews project migration under --dry-run", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--dry-run", "--project", "/tmp/some-project"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.commands.some((line) => line === "migrate-project-state.mjs /tmp/some-project"), true, result.commands.join("\n"));
    assert.equal(result.commands.some((line) => line === "team-doctor.sh /tmp/some-project --strict-share"), false, result.commands.join("\n"));
    assert.match(result.stdout, /project migration: would update legacy layout/);
    assert.match(result.stdout, /DRY RUN: bash .*team-doctor\.sh \/tmp\/some-project --strict-share/);
  });

  it("reports a missing project migrator clearly during --dry-run", () => {
    const stage = stageGlobalInstall();
    fs.rmSync(path.join(stage.platformRoot, "scripts", "migrate-project-state.mjs"));

    const result = runUpdate(stage, ["--dry-run", "--project", "/tmp/some-project"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /the updated helper has no project migrator at/);
    assert.doesNotMatch(result.stderr, /project migration failed/);
  });

  // piagent-install refuses to run against a host that does not match the version
  // its own package.json pins, so a helper installed ahead of the host fails on
  // its very next step.
  it("installs the host before the helper, and the package last", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, []);

    assert.equal(result.status, 0, result.stderr);
    const host = result.installs.findIndex((line) => line.includes("pi-coding-agent@0.82.0"));
    const helper = result.installs.findIndex((line) => line.includes("@piagent/platform@1.1.4"));
    const pkg = result.installs.findIndex((line) => line.startsWith("install-global.sh"));
    assert.ok(host >= 0 && helper >= 0 && pkg >= 0, result.installs.join("\n"));
    assert.ok(host < helper, `host must be installed before the helper: ${result.installs.join(" | ")}`);
    assert.ok(helper < pkg, `the helper must be replaced before its installer runs: ${result.installs.join(" | ")}`);
    assert.match(result.stdout, /PASS: updated to v1\.1\.4/);
  });

  it("keeps updates in the active writable npm prefix when npm config points elsewhere", () => {
    const stage = stageGlobalInstall({ defaultPrefixWritable: false });
    const result = runUpdate(stage, []);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /active helper is installed under/);
    assert.doesNotMatch(result.stdout, /PATH note/);
    assert.equal(result.installs.some((line) => line.includes(`--prefix ${stage.root}`) && line.includes("@piagent/platform@1.1.4")), true, result.installs.join("\n"));
    assert.match(result.stdout, new RegExp(`${stage.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*install-global\\.sh --stable`));
  });

  it("uses a user-writable npm prefix when both configured and active roots are locked", () => {
    const stage = stageGlobalInstall({ defaultPrefixWritable: false, activePrefixWritable: false });
    const result = runUpdate(stage, []);

    assert.equal(result.status, 0, result.stderr);
    const userPrefix = path.join(stage.root, ".pi", "npm-global");
    assert.match(result.stdout, /default global root is not writable/);
    assert.match(result.stdout, /PATH note/);
    assert.equal(result.installs.some((line) => line.includes(`--prefix ${userPrefix}`) && line.includes("@piagent/platform@1.1.4")), true, result.installs.join("\n"));
    assert.match(result.stdout, new RegExp(`${userPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*install-global\\.sh --stable`));

    restoreFixtureDirectoryPermissions(stage.root);
    for (const lockedPrefix of [
      path.join(stage.root, "lib", "node_modules"),
      path.join(stage.root, "readonly-global", "lib", "node_modules")
    ]) {
      assert.equal(fs.statSync(lockedPrefix).mode & 0o777, 0o700);
    }
  });

  it("reads the required host from the version being installed, not the one running", () => {
    const stage = stageGlobalInstall({ registryHost: "0.83.2", installedHost: "0.82.0" });
    const result = runUpdate(stage, ["--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host:\s+0\.82\.0 -> 0\.83\.2/);
    assert.match(result.stdout, /pi-coding-agent@0\.83\.2/);
  });

  it("accepts npm 12 singleton metadata arrays", () => {
    const stage = stageGlobalInstall({
      npmViewVersionResult: ["1.1.4"],
      npmViewPeerDependenciesResult: [{ "@earendil-works/pi-coding-agent": "0.82.0" }]
    });
    const result = runUpdate(stage, ["--check"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /helper:\s+1\.1\.0 -> 1\.1\.4/);
    assert.match(result.stdout, /host:\s+0\.81\.0 -> 0\.82\.0/);
  });

  it("refuses ambiguous npm metadata arrays", () => {
    const stage = stageGlobalInstall({
      npmViewPeerDependenciesResult: [
        { "@earendil-works/pi-coding-agent": "0.82.0" },
        { "@earendil-works/pi-coding-agent": "0.83.0" }
      ]
    });
    const result = runUpdate(stage, ["--version", "1.1.4", "--check"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not pin an exact/);
  });

  // npm reporting success is not evidence that the new files are on disk, and
  // every step after this one runs those files.
  it("stops before the package step when the helper did not actually land", () => {
    const stage = stageGlobalInstall({ registryVersion: "1.1.4", helperInstallLands: "1.1.0" });
    const result = runUpdate(stage, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reports 1\.1\.0/);
    assert.match(result.stderr, /Pi package was left untouched/);
    assert.equal(result.commands.some((line) => line.startsWith("install-global.sh")), false);
  });

  it("refuses to replace a git checkout with a published build", () => {
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/update-global.mjs"), "--version", "1.1.4"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /running from/);
    assert.match(result.stderr, /install-global\.sh --local/);
  });

  it("fails loudly when the registry cannot be reached", () => {
    const stage = stageGlobalInstall({ npmViewFails: true });
    const result = runUpdate(stage, ["--check"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot resolve a release/);
    assert.match(result.stderr, /--version/);
  });

  // An unpinned peer range cannot name the host to install, and guessing would
  // put the machine on a host the release never verified.
  it("refuses a target release that does not pin an exact host", () => {
    const stage = stageGlobalInstall({ registryPeers: { "@earendil-works/pi-coding-agent": "^0.82.0" } });
    const result = runUpdate(stage, ["--check"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not pin an exact/);
  });

  it("accepts an explicit target with or without the v prefix", () => {
    for (const requested of ["1.1.2", "v1.1.2"]) {
      const stage = stageGlobalInstall({ helperVersion: "1.1.4" });
      const result = runUpdate(stage, ["--version", requested, "--dry-run"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /helper:\s+1\.1\.4 -> 1\.1\.2/);
    }
  });

  it("rejects a target that is not an exact release", () => {
    const stage = stageGlobalInstall();
    for (const requested of ["latest", "^1.1.0", "1.1"]) {
      const result = runUpdate(stage, ["--version", requested]);
      assert.notEqual(result.status, 0, requested);
      assert.match(result.stderr, /needs an exact release/);
    }
  });

  it("rejects an unknown option instead of ignoring it", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--yolo"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option: --yolo/);
  });

  it("skips the parts it is told to skip", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--no-host", "--no-package"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.installs.some((line) => line.includes("pi-coding-agent")), false);
    assert.equal(result.installs.some((line) => line.startsWith("install-global.sh")), false);
    assert.equal(result.installs.some((line) => line.includes("@piagent/platform@1.1.4")), true);
  });

  it("hands everything after -- to the installer", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--", "--no-mcp", "--mcp-preset", "core"]);

    assert.equal(result.status, 0, result.stderr);
    const installer = result.commands.find((line) => line.startsWith("install-global.sh"));
    assert.equal(installer, "install-global.sh --stable --no-mcp --mcp-preset core");
  });

  it("migrates then runs the doctor against the project it was given", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--project", "/tmp/some-project"]);

    assert.equal(result.status, 0, result.stderr);
    const migration = result.commands.findIndex((line) => line === "migrate-project-state.mjs /tmp/some-project --apply --remove-old");
    const doctor = result.commands.findIndex((line) => line === "team-doctor.sh /tmp/some-project --strict-share");
    assert.ok(migration >= 0, result.commands.join("\n"));
    assert.ok(doctor >= 0, result.commands.join("\n"));
    assert.ok(migration < doctor, result.commands.join("\n"));
    assert.match(result.stdout, /project migration: applied/);
  });

  it("can run the project doctor without migration", () => {
    const stage = stageGlobalInstall();
    const result = runUpdate(stage, ["--project", "/tmp/some-project", "--no-migrate"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.commands.some((line) => line.startsWith("migrate-project-state.mjs")), false, result.commands.join("\n"));
    assert.equal(result.commands.some((line) => line === "team-doctor.sh /tmp/some-project --strict-share"), true, result.commands.join("\n"));
    assert.match(result.stdout, /project migration: skipped/);
  });

  it("still performs project work when install steps are skipped", () => {
    const current = { helperVersion: "1.1.4", registryVersion: "1.1.4", installedHost: "0.82.0" };
    const result = runUpdate(stageGlobalInstall(current), ["--no-package", "--project", "/tmp/some-project"]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Nothing to do/);
    assert.equal(result.commands.some((line) => line === "migrate-project-state.mjs /tmp/some-project --apply --remove-old"), true, result.commands.join("\n"));
    assert.equal(result.commands.some((line) => line === "team-doctor.sh /tmp/some-project --strict-share"), true, result.commands.join("\n"));
  });

  it("stops at the failing step instead of carrying on", () => {
    const stage = stageGlobalInstall({ npmInstallFails: "pi-coding-agent" });
    const result = runUpdate(stage, []);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not install @earendil-works\/pi-coding-agent/);
    assert.equal(result.installs.some((line) => line.includes("@piagent/platform@1.1.4")), false, "the helper must not move when the host failed");
  });

  it("reinstalls the current version only when forced", () => {
    const current = { helperVersion: "1.1.4", registryVersion: "1.1.4", installedHost: "0.82.0" };
    const quiet = runUpdate(stageGlobalInstall(current), ["--no-package"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.match(quiet.stdout, /Nothing to do/);
    assert.equal(quiet.commands.some((line) => line.startsWith("npm install")), false);

    const forced = runUpdate(stageGlobalInstall(current), ["--force", "--no-package"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(forced.installs.some((line) => line.includes("@piagent/platform@1.1.4")), true);
  });

  it("is exposed as a command by the package and the dispatcher", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(manifest.bin["piagent-update"], "scripts/piagent-cli.mjs");
    const dispatcher = fs.readFileSync(path.join(repositoryRoot, "scripts/piagent-cli.mjs"), "utf8");
    assert.match(dispatcher, /"piagent-update": "scripts\/update-global\.mjs"/);
  });
});
