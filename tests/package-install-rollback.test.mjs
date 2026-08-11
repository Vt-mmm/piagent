import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();
const baselineVersion = "1.2.17";
const baselineRef = `v${baselineVersion}^{}`;
const candidateVersion = "1.3.0-fs2.4";
const candidateOnlyModule = "packages/piagent-core/runtime/recovery/resume-state.ts";

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("piagent-package-lifecycle-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-package-lifecycle-"));
  temporaryRoots.add(root);
  return root;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function pack(cwd, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout)[0];
  const artifact = path.join(destination, report.filename);
  assert.equal(fs.existsSync(artifact), true, artifact);
  return { artifact, report };
}

function extract(artifact, destination) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", artifact, "-C", destination]);
}

function packageFiles(artifact) {
  return execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""));
}

function buildArtifacts(root) {
  const baselineSource = path.join(root, "baseline-source");
  const baselineArchive = path.join(root, "baseline.tar");
  fs.mkdirSync(baselineSource);
  const baselineCommit = execFileSync("git", ["rev-parse", baselineRef], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  assert.match(baselineCommit, /^[0-9a-f]{40}$/);
  execFileSync("git", ["archive", "--format=tar", "--output", baselineArchive, baselineRef], { cwd: repositoryRoot });
  execFileSync("tar", ["-xf", baselineArchive, "-C", baselineSource]);
  const baseline = pack(baselineSource, path.join(root, "baseline-artifact"));
  assert.equal(baseline.report.version, baselineVersion);

  const current = pack(repositoryRoot, path.join(root, "current-artifact"));
  const candidateSource = path.join(root, "candidate-source");
  extract(current.artifact, candidateSource);
  const candidatePackageRoot = path.join(candidateSource, "package");
  const manifestPath = path.join(candidatePackageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = candidateVersion;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const candidate = pack(candidatePackageRoot, path.join(root, "candidate-artifact"));
  assert.equal(candidate.report.version, candidateVersion);
  return { baseline, candidate };
}

function writePrivateOperatorState(root) {
  const agent = path.join(root, ".pi", "agent");
  const values = {
    "auth.json": "synthetic-private-auth-lineage\n",
    "settings.json": "{\"defaultProvider\":\"fixture\"}\n",
    "trust.json": "{\"fixture-project\":\"trusted\"}\n",
    "sessions/session.jsonl": "{\"event\":\"synthetic-private-session\"}\n"
  };
  for (const [relative, value] of Object.entries(values)) {
    const target = path.join(agent, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, value, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
  return agent;
}

function treeIdentity(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode });
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: "file", mode, size: stat.size, sha256: sha256(fs.readFileSync(absolute)) });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", mode, target: fs.readlinkSync(absolute) });
      } else {
        throw new Error(`unsupported operator-state node: ${relative}`);
      }
    }
  };
  visit(root);
  return `sha256:${sha256(JSON.stringify(entries))}`;
}

function installArtifact(artifact, prefix, operatorHome, cache) {
  const result = spawnSync("npm", [
    "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, artifact
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: operatorHome,
      PI_CODING_AGENT_DIR: path.join(operatorHome, ".pi", "agent"),
      npm_config_cache: cache,
      npm_config_update_notifier: "false"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function installedRoot(prefix) {
  return path.join(prefix, "lib", "node_modules", "@piagent", "platform");
}

function installedVersion(prefix) {
  return JSON.parse(fs.readFileSync(path.join(installedRoot(prefix), "package.json"), "utf8")).version;
}

function runInstalledHelp(prefix, operatorHome, command) {
  const executable = path.join(prefix, "bin", command);
  const result = spawnSync(executable, ["--help"], {
    encoding: "utf8",
    cwd: operatorHome,
    env: {
      ...process.env,
      HOME: operatorHome,
      PI_CODING_AGENT_DIR: path.join(operatorHome, ".pi", "agent"),
      PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      PIAGENT_NO_UPDATE_CHECK: "1"
    }
  });
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /Usage:/);
}

describe("full-source package install, upgrade, and rollback", () => {
  it("installs the real packed baseline, upgrades to the current full source, and rolls back without touching operator state", () => {
    const root = scratch();
    const { baseline, candidate } = buildArtifacts(root);
    const prefix = path.join(root, "npm-prefix");
    const operatorHome = path.join(root, "operator-home");
    const cache = path.join(root, "npm-cache");
    const agent = writePrivateOperatorState(operatorHome);
    const operatorBefore = treeIdentity(agent);

    const candidateFiles = packageFiles(candidate.artifact);
    assert.equal(candidateFiles.includes(candidateOnlyModule), true, "the full-source candidate module must ship");
    const forbidden = [
      /(?:^|\/)auth\.json$/i,
      /(?:^|\/)trust\.json$/i,
      /(?:^|\/)\.env(?:$|\.)/i,
      /(?:^|\/)\.pi\/piagent-state(?:\/|$)/i,
      /(?:^|\/)examples\/private(?:\/|$)/i,
      /(?:^|\/)docs\/(?:journals|decisions)(?:\/|$)/i
    ];
    assert.deepEqual(candidateFiles.filter((relative) => forbidden.some((pattern) => pattern.test(relative))), []);

    installArtifact(baseline.artifact, prefix, operatorHome, cache);
    assert.equal(installedVersion(prefix), baselineVersion);
    assert.equal(fs.existsSync(path.join(installedRoot(prefix), candidateOnlyModule)), false);
    runInstalledHelp(prefix, operatorHome, "piagent-install");

    installArtifact(candidate.artifact, prefix, operatorHome, cache);
    assert.equal(installedVersion(prefix), candidateVersion);
    const installedCandidateModule = path.join(installedRoot(prefix), candidateOnlyModule);
    assert.equal(fs.existsSync(installedCandidateModule), true);
    assert.equal(sha256(fs.readFileSync(installedCandidateModule)), sha256(fs.readFileSync(path.join(repositoryRoot, candidateOnlyModule))));
    runInstalledHelp(prefix, operatorHome, "piagent-doctor");

    installArtifact(baseline.artifact, prefix, operatorHome, cache);
    assert.equal(installedVersion(prefix), baselineVersion);
    assert.equal(fs.existsSync(path.join(installedRoot(prefix), candidateOnlyModule)), false, "rollback must remove candidate-only production modules");
    runInstalledHelp(prefix, operatorHome, "piagent-install");

    assert.equal(treeIdentity(agent), operatorBefore, "auth, settings, trust, and session bytes/modes must remain unchanged");
  });

  it("runs the same package lifecycle regression in the declared macOS and Linux verification matrix", () => {
    const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "verify.yml"), "utf8");
    assert.match(workflow, /matrix:\s*\n\s*os:\s*\n\s*- ubuntu-latest\s*\n\s*- macos-latest/);
    assert.match(workflow, /node-version:\s*["']22\.19\.0["']/);
    assert.match(workflow, /- name: Run policy regression tests\s*\n\s*run: npm test/);
    assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  });
});
