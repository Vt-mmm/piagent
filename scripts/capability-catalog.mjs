#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityValidationError,
  buildCapabilityCatalog,
  resolveCapabilityProfile,
  resolveCapabilityProfileDocument,
  stableJson,
  validateCapabilityPackageSource,
  validateExternalActionProposal,
  verifyCapabilityLock,
  writeJsonAtomic,
  writeProfileLockAtomic
} from "../packages/piagent-core/capabilities/capability-core.js";

const platformRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(platformRoot, "catalog", "capabilities.json");

function usage() {
  process.stdout.write(`Usage:
  piagent-capabilities catalog [--check | --write]
  piagent-capabilities resolve --profile <profile.json> [--output <lock.json>] [--package-source <source>]
  piagent-capabilities apply-profile --profile <source.json> --target <piagent-profile.json> [--package-source <source>] [--force]
  piagent-capabilities doctor [--profile <profile.json>] [--lock <lock.json>] [--package-source <source>]
  piagent-capabilities validate-source --package-source <source>
  piagent-capabilities validate-action --file <proposal.json>

Commands:
  catalog          Build the deterministic capability catalog.
  resolve          Resolve a profile to an auditable lock document.
  apply-profile    Validate and update a profile with its lock as one fail-closed operation.
  doctor           Validate packs, profile grants, and an optional lock document.
  validate-source  Require a local source or an exact remote version, tag, or commit.
  validate-action  Validate a dry-run external action proposal.
`);
}

function parseArguments(values) {
  const output = { positional: [], flags: new Map() };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      output.positional.push(value);
      continue;
    }
    if (["--check", "--write", "--force", "--help"].includes(value)) {
      if (output.flags.has(value)) throw new CapabilityValidationError(`duplicate option ${value}`);
      output.flags.set(value, true);
      continue;
    }
    if (!["--profile", "--output", "--target", "--lock", "--file", "--package-source"].includes(value)) throw new CapabilityValidationError(`unknown option ${value}`);
    if (output.flags.has(value)) throw new CapabilityValidationError(`duplicate option ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new CapabilityValidationError(`${value} requires a value`);
    output.flags.set(value, next);
    index += 1;
  }
  return output;
}

function assertAllowedFlags(flags, allowed) {
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) throw new CapabilityValidationError(`${flag} is not valid for this command`);
  }
}

function requireExistingFile(value, option) {
  if (!value) throw new CapabilityValidationError(`${option} is required`);
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CapabilityValidationError(`${option} must identify a regular file`);
  return fs.realpathSync(absolute);
}

function readJson(file) {
  const stat = fs.statSync(file);
  if (stat.size > 256 * 1024) throw new CapabilityValidationError(`${file} exceeds the 262144-byte limit`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new CapabilityValidationError(`${file} contains invalid JSON`, [error instanceof Error ? error.message : String(error)]);
  }
}

function assertOutputBesideProfile(output, profile) {
  const absolute = path.resolve(output);
  const profileDirectory = path.dirname(profile);
  const outputDirectory = fs.realpathSync(path.dirname(absolute));
  if (outputDirectory !== profileDirectory) throw new CapabilityValidationError("--output must be in the same directory as --profile");
  if (path.basename(absolute) !== "piagent-profile.lock.json") throw new CapabilityValidationError("--output filename must be piagent-profile.lock.json");
  return path.join(outputDirectory, path.basename(absolute));
}

function packageSourceBesideProfile(profile) {
  const settingsPath = path.join(path.dirname(profile), "settings.json");
  if (!fs.existsSync(settingsPath)) return "workspace";
  const settings = readJson(settingsPath);
  const source = Array.isArray(settings.packages) ? settings.packages.find((item) => typeof item === "string" && item.length > 0) : undefined;
  return source ?? "workspace";
}

function runCatalog(flags) {
  assertAllowedFlags(flags, new Set(["--check", "--write"]));
  if (flags.has("--check") && flags.has("--write")) throw new CapabilityValidationError("--check and --write are mutually exclusive");
  const catalog = buildCapabilityCatalog(platformRoot);
  if (flags.has("--check")) {
    if (!fs.existsSync(catalogPath)) throw new CapabilityValidationError("catalog/capabilities.json is missing");
    const existing = fs.readFileSync(catalogPath, "utf8");
    if (existing !== stableJson(catalog)) throw new CapabilityValidationError("catalog/capabilities.json is stale");
    process.stdout.write(`${JSON.stringify({ ok: true, catalog: "catalog/capabilities.json", packs: catalog.packs.length })}\n`);
    return;
  }
  if (flags.has("--write")) {
    writeJsonAtomic(catalogPath, catalog);
    process.stdout.write(`${JSON.stringify({ ok: true, catalog: "catalog/capabilities.json", packs: catalog.packs.length })}\n`);
    return;
  }
  process.stdout.write(stableJson(catalog));
}

function runResolve(flags) {
  assertAllowedFlags(flags, new Set(["--profile", "--output", "--package-source"]));
  const profile = requireExistingFile(flags.get("--profile"), "--profile");
  const packageSource = flags.get("--package-source") ?? "workspace";
  const lock = resolveCapabilityProfile(platformRoot, profile, { packageSource });
  if (flags.has("--output")) {
    const output = assertOutputBesideProfile(flags.get("--output"), profile);
    writeJsonAtomic(output, lock);
    process.stdout.write(`${JSON.stringify({ ok: true, output, packs: lock.packs.length })}\n`);
    return;
  }
  process.stdout.write(stableJson(lock));
}

function runApplyProfile(flags) {
  assertAllowedFlags(flags, new Set(["--profile", "--target", "--package-source", "--force"]));
  const source = requireExistingFile(flags.get("--profile"), "--profile");
  const targetValue = flags.get("--target");
  if (!targetValue) throw new CapabilityValidationError("--target is required");
  const target = path.resolve(targetValue);
  if (path.basename(target) !== "piagent-profile.json") throw new CapabilityValidationError("--target filename must be piagent-profile.json");
  const parent = fs.realpathSync(path.dirname(target));
  const normalizedTarget = path.join(parent, path.basename(target));
  if (fs.existsSync(normalizedTarget) && !flags.has("--force")) throw new CapabilityValidationError("target profile already exists; pass --force to replace it");
  const profile = readJson(source);
  const packageSource = flags.get("--package-source") ?? "workspace";
  const lock = resolveCapabilityProfileDocument(platformRoot, profile, {
    profileFile: path.basename(normalizedTarget),
    packageSource
  });
  const lockTarget = path.join(parent, "piagent-profile.lock.json");
  writeProfileLockAtomic(normalizedTarget, profile, lockTarget, lock);
  process.stdout.write(`${JSON.stringify({ ok: true, profile: normalizedTarget, lock: lockTarget, packs: lock.packs.length })}\n`);
}

function runDoctor(flags) {
  assertAllowedFlags(flags, new Set(["--profile", "--lock", "--package-source"]));
  const catalog = buildCapabilityCatalog(platformRoot);
  const report = {
    ok: true,
    catalog: {
      path: "catalog/capabilities.json",
      packs: catalog.packs.length,
      current: fs.existsSync(catalogPath) && fs.readFileSync(catalogPath, "utf8") === stableJson(catalog)
    }
  };
  if (!report.catalog.current) throw new CapabilityValidationError("catalog/capabilities.json is missing or stale");
  if (flags.has("--profile")) {
    const profile = requireExistingFile(flags.get("--profile"), "--profile");
    const packageSource = flags.get("--package-source") ?? packageSourceBesideProfile(profile);
    const resolved = resolveCapabilityProfile(platformRoot, profile, { packageSource });
    report.profile = {
      path: profile,
      projectId: resolved.profile.projectId,
      packs: resolved.packs.map((pack) => `${pack.name}@${pack.version}`),
      permissions: resolved.permissions
    };
    if (flags.has("--lock")) {
      const lockFile = requireExistingFile(flags.get("--lock"), "--lock");
      if (path.dirname(lockFile) !== path.dirname(profile)) throw new CapabilityValidationError("--lock must be in the same directory as --profile");
      const verification = verifyCapabilityLock(platformRoot, profile, readJson(lockFile), { packageSource });
      report.lock = {
        path: lockFile,
        current: verification.ok,
        expectedDigest: verification.expectedDigest,
        actualDigest: verification.actualDigest
      };
      if (!verification.ok) throw new CapabilityValidationError("capability lock is stale or has been modified");
    }
  } else if (flags.has("--lock")) {
    throw new CapabilityValidationError("--lock requires --profile");
  }
  process.stdout.write(stableJson(report));
}

function runValidateAction(flags) {
  assertAllowedFlags(flags, new Set(["--file"]));
  const file = requireExistingFile(flags.get("--file"), "--file");
  validateExternalActionProposal(readJson(file), { source: file });
  process.stdout.write(`${JSON.stringify({ ok: true, file })}\n`);
}

function runValidateSource(flags) {
  assertAllowedFlags(flags, new Set(["--package-source"]));
  const source = flags.get("--package-source");
  if (!source) throw new CapabilityValidationError("--package-source is required");
  validateCapabilityPackageSource(source);
  process.stdout.write(`${JSON.stringify({ ok: true, packageSource: source })}\n`);
}

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.flags.has("--help") || parsed.positional.length === 0) {
    usage();
    process.exit(parsed.flags.has("--help") ? 0 : 2);
  }
  if (parsed.positional.length !== 1) throw new CapabilityValidationError("exactly one command is required");
  const command = parsed.positional[0];
  if (command === "catalog") runCatalog(parsed.flags);
  else if (command === "resolve") runResolve(parsed.flags);
  else if (command === "apply-profile") runApplyProfile(parsed.flags);
  else if (command === "doctor") runDoctor(parsed.flags);
  else if (command === "validate-source") runValidateSource(parsed.flags);
  else if (command === "validate-action") runValidateAction(parsed.flags);
  else throw new CapabilityValidationError(`unknown command ${command}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FAIL: ${message}\n`);
  if (error instanceof CapabilityValidationError) {
    for (const detail of error.errors) process.stderr.write(`- ${detail}\n`);
  }
  process.exit(1);
}
