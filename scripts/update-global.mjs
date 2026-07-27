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
  --project <path>        Run the team doctor against this project afterwards
  --no-host               Do not touch the Pi host
  --no-package            Do not reinstall the Pi package
  -h, --help              Show this help

Anything after -- is passed through to piagent-install, for example:
  piagent-update -- --no-mcp
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

function npmView(specifier, field) {
  const result = run("npm", ["view", specifier, field, "--json"], { capture: true });
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout.trim());
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

  if (options.check) {
    const pending = [helperNeedsChange && "helper", hostNeedsChange && "host"].filter(Boolean);
    console.log(pending.length ? `\nUpdate available: ${pending.join(", ")}.` : "\nEverything is on the target release.");
    return;
  }

  if (!helperNeedsChange && !hostNeedsChange && !options.package) {
    console.log("\nNothing to do.");
    return;
  }

  if (!options.dryRun && !runningFromGlobalInstall()) {
    fail(`this command updates the npm-global helper, but it is running from ${platformRoot}.\n`
      + "From a checkout, update with git and install from it:\n"
      + `  git -C ${platformRoot} pull\n`
      + `  bash ${path.join(platformRoot, "scripts/install-global.sh")} --local`);
  }

  // Host first: piagent-install refuses to run against a host that does not match
  // the version its package.json pins, so a helper installed ahead of the host
  // would fail on its very next step.
  if (hostNeedsChange) {
    const args = ["install", "-g", "--ignore-scripts", `${HOST_PACKAGE}@${targetHost}`];
    describeStep(options.dryRun, "npm", args);
    if (!options.dryRun && !run("npm", args).ok) fail(`could not install ${HOST_PACKAGE}@${targetHost}`);
  }

  if (helperNeedsChange) {
    const args = ["install", "-g", "--ignore-scripts", `${HELPER_PACKAGE}@${targetHelper}`];
    describeStep(options.dryRun, "npm", args);
    if (!options.dryRun) {
      if (!run("npm", args).ok) fail(`could not install ${HELPER_PACKAGE}@${targetHelper}`);
      // The helper has just replaced itself on disk. Everything after this point
      // runs the newly installed scripts, so confirm they are the ones asked for
      // rather than trusting that npm did what it said.
      const landed = readJson(path.join(platformRoot, "package.json"))?.version;
      if (landed !== targetHelper) {
        fail(`installed ${HELPER_PACKAGE}@${targetHelper} but ${platformRoot} reports ${landed ?? "nothing"}. `
          + "The Pi package was left untouched; rerun once the helper is correct.");
      }
    }
  }

  if (options.package) {
    const installer = path.join(platformRoot, "scripts/install-global.sh");
    if (!options.dryRun && !fs.existsSync(installer)) {
      fail(`the updated helper has no installer at ${installer}`);
    }
    const args = [installer, "--stable", ...options.passthrough];
    describeStep(options.dryRun, "bash", args);
    if (!options.dryRun && !run("bash", args).ok) fail("the Pi package install did not complete");
  }

  if (options.project) {
    const doctor = path.join(platformRoot, "scripts/team-doctor.sh");
    const args = [doctor, options.project, "--strict-share"];
    describeStep(options.dryRun, "bash", args);
    if (!options.dryRun && !run("bash", args).ok) fail("the team doctor reported a problem");
  }

  console.log(options.dryRun
    ? `\nDRY RUN: nothing was installed. Rerun without --dry-run to apply v${targetHelper}.`
    : `\nPASS: updated to v${targetHelper}.`);
}

main();
