#!/usr/bin/env node
// One command that moves a machine from one release to the next.
//
// A release is three independently versioned things: the Pi host, this npm-global
// terminal helper, and the Pi package the helper installs. They have to move in
// that order, because `piagent-install` refuses to run against a host that does
// not match the version its own package.json pins. Doing it by hand means three
// commands and one ordering rule, and getting the order wrong fails late.
//
// The awkward part is that the helper is the program running this file, so it has
// to replace itself. Rather than re-exec a half-replaced process, every version
// this run needs is resolved from the registry *before* anything is installed:
// the target helper version and, from that version's metadata, the host version it
// will demand. The plan is therefore complete and printable before the first
// mutation, `--dry-run` shows exactly what a real run would do, and after the
// helper is replaced the run only has to confirm that what landed on disk is what
// it asked for.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HELPER_PACKAGE = "@piagent/platform";
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const EXIT_USAGE = 2;

const platformRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  piagent-update [options]

Updates the Pi host, this terminal helper, and the Pi package together, in the
order a release requires.

Options:
  --check                 Report current and available versions, change nothing
  --dry-run               Print every command that would run, change nothing
  --version <x.y.z>       Update to an exact helper version instead of latest
  --force                 Reinstall even when already on the target version
  --project <path>        Optional: after the global update, migrate and doctor this project
  --no-host               Do not touch the Pi host
  --no-package            Do not reinstall the Pi package
  --no-migrate            With --project, skip project state migration
  --npm-prefix <path>     Use this npm global prefix for host/helper installs
  -h, --help              Show this help

Anything after -- is passed through to piagent-install, for example:
  piagent-update -- --no-mcp

Bootstrap a machine that does not have piagent-update yet:
  npm exec -y --package @piagent/platform@X.Y.Z -- piagent-update --version X.Y.Z --force
`;
}

function fail(message, code = 1) {
  console.error(`FAIL: ${message}`);
  process.exit(code);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isReleaseVersion(value) {
  return typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/.test(value);
}

// "v1.2.3" and "1.2.3" both name the same release everywhere else in this
// repository, so accept either and normalise once.
function normalizeVersion(value) {
  return typeof value === "string" && value.startsWith("v") ? value.slice(1) : value;
}

function parseArguments(argv) {
  const options = {
    check: false,
    dryRun: false,
    force: false,
    version: undefined,
    project: undefined,
    host: true,
    package: true,
    migrate: true,
    npmPrefix: undefined,
    passthrough: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options.passthrough = argv.slice(index + 1);
      break;
    }
    switch (argument) {
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
        break;
      case "--check":
        options.check = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--no-host":
        options.host = false;
        break;
      case "--no-package":
        options.package = false;
        break;
      case "--no-migrate":
        options.migrate = false;
        break;
      case "--npm-prefix": {
        const value = argv[index += 1];
        if (!value) fail("--npm-prefix needs a path", EXIT_USAGE);
        options.npmPrefix = value;
        break;
      }
      case "--version": {
        const value = normalizeVersion(argv[index += 1]);
        if (!isReleaseVersion(value)) fail(`--version needs an exact release such as 1.1.4, got ${argv[index] ?? "nothing"}`, EXIT_USAGE);
        options.version = value;
        break;
      }
      case "--project": {
        const value = argv[index += 1];
        if (!value) fail("--project needs a path", EXIT_USAGE);
        options.project = value;
        break;
      }
      default:
        fail(`unknown option: ${argument}\n\n${usage()}`, EXIT_USAGE);
    }
  }

  return options;
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message ?? result.error) };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value?.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configuredNpmPrefix() {
  const result = run("npm", ["config", "get", "prefix"], { capture: true });
  if (!result.ok) return undefined;
  const prefix = result.stdout.trim();
  return prefix && prefix !== "undefined" && prefix !== "null" ? path.resolve(expandHome(prefix)) : undefined;
}

function fallbackNpmRoot(prefix) {
  return process.platform === "win32"
    ? path.join(prefix, "node_modules")
    : path.join(prefix, "lib", "node_modules");
}

function npmRoot(prefix) {
  const args = ["root", "-g"];
  if (prefix) args.push("--prefix", prefix);
  const result = run("npm", args, { capture: true });
  if (result.ok && result.stdout.trim()) return path.resolve(expandHome(result.stdout.trim()));
  return prefix ? fallbackNpmRoot(prefix) : undefined;
}

function nearestExistingPath(target) {
  let current = target;
  while (current && !fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current || undefined;
}

function canWriteOrCreate(target) {
  const nearest = nearestExistingPath(target);
  if (!nearest) return false;
  try {
    fs.accessSync(nearest, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function userNpmPrefix() {
  return path.join(os.homedir(), ".pi", "npm-global");
}

function binForPrefix(prefix) {
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function prependPath(directory) {
  process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ""}`;
}

function resolveNpmInstallTarget(options, needsGlobalInstall) {
  const explicitPrefix = options.npmPrefix ? path.resolve(expandHome(options.npmPrefix)) : undefined;
  if (explicitPrefix) {
    if (!options.dryRun) fs.mkdirSync(explicitPrefix, { recursive: true });
    return {
      prefix: explicitPrefix,
      root: npmRoot(explicitPrefix),
      bin: binForPrefix(explicitPrefix),
      reason: "explicit"
    };
  }

  const defaultPrefix = configuredNpmPrefix();
  const defaultRoot = npmRoot(defaultPrefix);
  if (!needsGlobalInstall || (defaultRoot && canWriteOrCreate(defaultRoot))) {
    return { prefix: undefined, root: defaultRoot, bin: undefined, reason: "default" };
  }

  const prefix = userNpmPrefix();
  if (!options.dryRun) fs.mkdirSync(prefix, { recursive: true });
  return {
    prefix,
    root: npmRoot(prefix),
    bin: binForPrefix(prefix),
    reason: "user-prefix",
    blockedRoot: defaultRoot
  };
}

function npmInstallArgs(specifier, npmTarget) {
  const args = ["install", "-g", "--ignore-scripts"];
  if (npmTarget.prefix) args.push("--prefix", npmTarget.prefix);
  args.push(specifier);
  return args;
}

function helperRootFromNpmTarget(npmTarget) {
  return npmTarget.root ? path.join(npmTarget.root, "@piagent", "platform") : undefined;
}

function helperVersionAt(root) {
  return root ? readJson(path.join(root, "package.json"))?.version : undefined;
}

function resolveInstalledHelperRoot(targetHelper, npmTarget) {
  const npmHelperRoot = helperRootFromNpmTarget(npmTarget);
  if (helperVersionAt(npmHelperRoot) === targetHelper) return npmHelperRoot;
  if (helperVersionAt(platformRoot) === targetHelper) return platformRoot;
  const checked = [];
  for (const root of [npmHelperRoot, platformRoot]) {
    if (!root || checked.some((entry) => entry.root === root)) continue;
    checked.push({ root, version: helperVersionAt(root) ?? "nothing" });
  }
  const details = checked.map((entry) => `${entry.root} reports ${entry.version}`).join("; ");
  fail(`installed ${HELPER_PACKAGE}@${targetHelper}, but ${details || "the helper paths did not report that version"}. `
    + "The Pi package was left untouched; rerun once the helper is correct.");
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout.trim() || "{}");
  } catch {
    fail(`${label} did not return valid JSON:\n${result.stdout.trim()}`);
  }
}

function summarizeMigration(report, dryRun) {
  const renamed = report.renamed?.length ?? 0;
  const removed = report.removedOld?.length ?? 0;
  const rewrote = report.rewrote?.length ?? report.wouldRewrite?.length ?? 0;
  const wouldRename = report.wouldRename?.length ?? 0;
  const alreadyMigrated = report.alreadyMigrated?.length ?? 0;

  if (dryRun) {
    const planned = wouldRename + rewrote + alreadyMigrated;
    return planned > 0
      ? `project migration: would update legacy layout (${wouldRename} rename, ${rewrote} rewrite, ${alreadyMigrated} already copied)`
      : "project migration: already current";
  }
  if (report.migrated === false) return "project migration: already current";
  return `project migration: applied (${renamed} rename, ${rewrote} rewrite, ${removed} old path removed)`;
}

function runProjectMigration(project, options, activePlatformRoot) {
  const migrator = path.join(activePlatformRoot, "scripts/migrate-project-state.mjs");
  if (!options.dryRun && !fs.existsSync(migrator)) {
    fail(`the updated helper has no project migrator at ${migrator}`);
  }
  const args = options.dryRun
    ? [migrator, project]
    : [migrator, project, "--apply", "--remove-old"];
  describeStep(options.dryRun, process.execPath, args);
  const result = run(process.execPath, args, { capture: true });
  if (!result.ok) fail(`project migration failed:\n${result.stderr.trim() || result.stdout.trim()}`);
  const report = parseJsonOutput(result, "project migration");
  if ((report.skipped?.length ?? 0) > 0) {
    fail(`project migration skipped protected entries: ${report.skipped.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`);
  }
  console.log(`  ${summarizeMigration(report, options.dryRun)}`);
}

function normalizeNpmViewResult(value) {
  if (!Array.isArray(value)) return value;
  return value.length === 1 ? value[0] : undefined;
}

function npmView(specifier, field) {
  const result = run("npm", ["view", specifier, field, "--json"], { capture: true });
  if (!result.ok) return undefined;
  try {
    const raw = result.stdout.trim();
    return raw ? normalizeNpmViewResult(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

function installedHostVersion() {
  const result = run("pi", ["--version"], { capture: true });
  if (!result.ok) return undefined;
  const match = /([0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?)/.exec(result.stdout);
  return match ? match[1] : undefined;
}

// The helper installs itself from the registry, so a run started from a git
// checkout would replace the checkout's own commands with a published build and
// leave the operator somewhere they did not ask to be.
function runningFromGlobalInstall() {
  return platformRoot.split(path.sep).includes("node_modules");
}

function describeStep(dryRun, command, args) {
  console.log(`${dryRun ? "DRY RUN:" : "run:"} ${command} ${args.join(" ")}`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));

  const manifest = readJson(path.join(platformRoot, "package.json"));
  if (!manifest?.version) fail(`cannot read the helper package at ${platformRoot}`);
  const currentHelper = manifest.version;
  const currentHost = installedHostVersion();

  const targetHelper = options.version ?? npmView(HELPER_PACKAGE, "version");
  if (!isReleaseVersion(targetHelper)) {
    fail(`cannot resolve a release for ${HELPER_PACKAGE}. Check network access to the npm registry, or pass --version.`);
  }

  // The host requirement belongs to the version being installed, not the one
  // running, so it is read from the target's published metadata.
  const targetPeers = npmView(`${HELPER_PACKAGE}@${targetHelper}`, "peerDependencies");
  const targetHost = targetPeers?.[HOST_PACKAGE];
  if (!isReleaseVersion(targetHost)) {
    fail(`${HELPER_PACKAGE}@${targetHelper} does not pin an exact ${HOST_PACKAGE} version, so the host cannot be updated safely.`);
  }

  const helperNeedsChange = options.force || currentHelper !== targetHelper;
  const hostNeedsChange = options.host && (options.force || currentHost !== targetHost);

  console.log("Pi Agent Platform update");
  console.log(`  helper:  ${currentHelper} -> ${targetHelper}${helperNeedsChange ? "" : " (already current)"}`);
  console.log(`  host:    ${currentHost ?? "not installed"} -> ${targetHost}${hostNeedsChange ? "" : " (already current)"}`);
  console.log(`  package: reinstalled from v${targetHelper} as a resolved commit${options.package ? "" : " (skipped)"}`);
  if (options.project) {
    console.log(`  project: ${path.resolve(options.project)} (${options.migrate ? "migrate + doctor" : "doctor only"})`);
  }

  if (options.check) {
    const pending = [helperNeedsChange && "helper", hostNeedsChange && "host"].filter(Boolean);
    console.log(pending.length ? `\nUpdate available: ${pending.join(", ")}.` : "\nEverything is on the target release.");
    return;
  }

  if (!helperNeedsChange && !hostNeedsChange && !options.package && !options.project) {
    console.log("\nNothing to do.");
    return;
  }

  if (!options.dryRun && !runningFromGlobalInstall()) {
    fail(`this command updates the npm-global helper, but it is running from ${platformRoot}.\n`
      + "From a checkout, update with git and install from it:\n"
      + `  git -C ${platformRoot} pull\n`
      + `  bash ${path.join(platformRoot, "scripts/install-global.sh")} --local`);
  }

  let activePlatformRoot = platformRoot;
  const npmTarget = resolveNpmInstallTarget(options, hostNeedsChange || helperNeedsChange);
  if (npmTarget.bin) prependPath(npmTarget.bin);
  if (npmTarget.reason === "user-prefix") {
    console.log(`  npm:     default global root is not writable (${npmTarget.blockedRoot ?? "unknown"}); using ${npmTarget.prefix}`);
  } else if (npmTarget.reason === "explicit") {
    console.log(`  npm:     using explicit global prefix ${npmTarget.prefix}`);
  }

  // Host first: piagent-install refuses to run against a host that does not match
  // the version its package.json pins, so a helper installed ahead of the host
  // would fail on its very next step.
  if (hostNeedsChange) {
    const args = npmInstallArgs(`${HOST_PACKAGE}@${targetHost}`, npmTarget);
    describeStep(options.dryRun, "npm", args);
    if (!options.dryRun && !run("npm", args).ok) fail(`could not install ${HOST_PACKAGE}@${targetHost}`);
  }

  if (helperNeedsChange) {
    const args = npmInstallArgs(`${HELPER_PACKAGE}@${targetHelper}`, npmTarget);
    describeStep(options.dryRun, "npm", args);
    if (!options.dryRun) {
      if (!run("npm", args).ok) fail(`could not install ${HELPER_PACKAGE}@${targetHelper}`);
      // The helper has just replaced itself on disk. Everything after this point
      // runs the newly installed scripts, so confirm they are the ones asked for
      // rather than trusting that npm did what it said.
      activePlatformRoot = resolveInstalledHelperRoot(targetHelper, npmTarget);
    }
  }

  if (options.package) {
    const installer = path.join(activePlatformRoot, "scripts/install-global.sh");
    if (!options.dryRun && !fs.existsSync(installer)) {
      fail(`the updated helper has no installer at ${installer}`);
    }
    const args = [installer, "--stable", ...options.passthrough];
    describeStep(options.dryRun, "bash", args);
    if (!options.dryRun && !run("bash", args).ok) fail("the Pi package install did not complete");
  }

  if (options.project) {
    if (options.migrate) {
      runProjectMigration(options.project, options, activePlatformRoot);
    } else {
      console.log("  project migration: skipped");
    }
    const doctor = path.join(activePlatformRoot, "scripts/team-doctor.sh");
    const args = [doctor, options.project, "--strict-share"];
    describeStep(options.dryRun, "bash", args);
    if (!options.dryRun && !run("bash", args).ok) fail("the team doctor reported a problem");
  }

  if (npmTarget.reason === "user-prefix") {
    console.log(`\nPATH note: add this once if your shell cannot find piagent-* commands later:`);
    console.log(`  export PATH="${npmTarget.bin}:$PATH"`);
  }

  console.log(options.dryRun
    ? `\nDRY RUN: nothing was installed. Rerun without --dry-run to apply v${targetHelper}.`
    : `\nPASS: updated to v${targetHelper}.`);
}

main();
