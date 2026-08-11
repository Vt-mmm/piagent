#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enumerateProductionPaths } from "../fs0/verify-capability-ownership-manifest.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_MANIFEST = path.join(path.dirname(SCRIPT_PATH), "capability-module-ownership-delta.v3.json");
const ALGORITHM = "piagent-capability-ownership-delta-v3";
const DOMAIN = `${ALGORITHM}\n`;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
}

function stableFileEntry(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const relativeCheck = path.relative(repositoryRoot, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error(`path escapes repository: ${relativePath}`);
  const pathBefore = fs.lstatSync(absolutePath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) throw new Error(`not a regular file: ${relativePath}`);
  const descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    const content = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    const identity = (left, right) => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
      && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    if (!identity(pathBefore, openedBefore) || !identity(openedBefore, openedAfter) || !identity(openedAfter, pathAfter)) {
      throw new Error(`file changed during read: ${relativePath}`);
    }
    return {
      size: content.length,
      mode: Number(openedAfter.mode & 0o7777n).toString(8).padStart(4, "0"),
      sha256: sha256(content)
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left, right) {
  return left.size === right.size && left.mode === right.mode && left.sha256 === right.sha256;
}

function verifyEntry(repositoryRoot, entry, capabilityIds) {
  equal(JSON.stringify(Object.keys(entry)), JSON.stringify(["path", "cap", "size", "mode", "sha256"]), `${entry.path} key order`);
  if (!capabilityIds.has(entry.cap)) throw new Error(`unknown capability ${entry.cap} for ${entry.path}`);
  const current = stableFileEntry(repositoryRoot, entry.path);
  equal(entry.size, current.size, `${entry.path} size`);
  equal(entry.mode, current.mode, `${entry.path} mode`);
  equal(entry.sha256, current.sha256, `${entry.path} SHA-256`);
}

export function verifyCapabilityOwnershipDeltaV3(manifestPath = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  equal(manifest.schemaVersion, "capability-module-ownership-delta-v3", "schemaVersion");
  equal(manifest.workItem, "CF-FS1-04", "work item");
  equal(manifest.ownershipAggregate?.algorithm, ALGORITHM, "aggregate algorithm");
  equal(manifest.ownershipAggregate?.domainUtf8, DOMAIN, "aggregate domain");
  const directory = path.dirname(manifestPath);
  const repositoryRoot = path.resolve(directory, manifest.repositoryRoot.relativePathFromManifest);
  const basePath = path.resolve(directory, manifest.baseManifest.relativePathFromManifest);
  const priorV2Path = path.resolve(directory, manifest.priorDelta.relativePathFromManifest);
  const constitutionPath = path.resolve(directory, manifest.constitution.relativePathFromManifest);
  const verifierPath = path.resolve(directory, manifest.referenceVerifier.relativePathFromManifest);
  equal(sha256(fs.readFileSync(basePath)), manifest.baseManifest.sha256, "base manifest SHA-256");
  equal(sha256(fs.readFileSync(priorV2Path)), manifest.priorDelta.sha256, "prior delta SHA-256");
  equal(sha256(fs.readFileSync(constitutionPath)), manifest.constitution.sha256, "constitution SHA-256");
  equal(sha256(fs.readFileSync(verifierPath)), manifest.referenceVerifier.sha256, "verifier SHA-256");

  const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const priorV2 = JSON.parse(fs.readFileSync(priorV2Path, "utf8"));
  const priorV1Path = path.resolve(path.dirname(priorV2Path), priorV2.priorDelta.relativePathFromManifest);
  equal(sha256(fs.readFileSync(priorV1Path)), priorV2.priorDelta.sha256, "v1 delta SHA-256");
  const priorV1 = JSON.parse(fs.readFileSync(priorV1Path, "utf8"));
  const constitution = JSON.parse(fs.readFileSync(constitutionPath, "utf8"));
  const currentPaths = enumerateProductionPaths(repositoryRoot, constitution.productionModuleScope);
  const currentSet = new Set(currentPaths);
  const priorEntries = [...priorV1.entries, ...priorV2.entries];
  const inheritedPaths = [...base.entries.map((entry) => entry.path), ...priorEntries.map((entry) => entry.path)];
  const inheritedSet = new Set(inheritedPaths);
  equal(inheritedSet.size, inheritedPaths.length, "unique inherited ownership paths");
  const removed = inheritedPaths.filter((entry) => !currentSet.has(entry));
  if (removed.length > 0) throw new Error(`inherited paths removed: ${removed.join(", ")}`);

  const additions = currentPaths.filter((entry) => !inheritedSet.has(entry));
  const declaredPaths = manifest.entries.map((entry) => entry.path);
  equal(JSON.stringify(declaredPaths), JSON.stringify([...declaredPaths].sort(compareUtf8)), "entry order");
  equal(JSON.stringify(declaredPaths), JSON.stringify(additions), "exact additive path coverage");
  equal(new Set(declaredPaths).size, declaredPaths.length, "unique additive paths");
  equal(manifest.entries.length, manifest.totalFiles, "declared additive file count");
  equal(currentPaths.length, manifest.currentProductionFileCount, "current production file count");

  const capabilityIds = new Set(constitution.capabilities.map((entry) => entry.id));
  const updatedPaths = manifest.updatedEntries.map((entry) => entry.path);
  equal(JSON.stringify(updatedPaths), JSON.stringify([...updatedPaths].sort(compareUtf8)), "updated entry order");
  equal(new Set(updatedPaths).size, updatedPaths.length, "unique updated paths");
  equal(manifest.updatedEntries.length, manifest.updatedFiles, "updated file count");
  const updatedByPath = new Map(manifest.updatedEntries.map((entry) => [entry.path, entry]));
  const priorByPath = new Map(priorEntries.map((entry) => [entry.path, entry]));
  for (const updated of manifest.updatedEntries) {
    const prior = priorByPath.get(updated.path);
    if (!prior) throw new Error(`updated path is not owned by a prior FS1 delta: ${updated.path}`);
    equal(updated.cap, prior.cap, `${updated.path} primary owner`);
    if (sameFileIdentity(updated, prior)) throw new Error(`updated entry does not describe content or mode drift: ${updated.path}`);
  }
  for (const prior of priorEntries) {
    const current = stableFileEntry(repositoryRoot, prior.path);
    const updated = updatedByPath.get(prior.path);
    if (updated) verifyEntry(repositoryRoot, updated, capabilityIds);
    else {
      equal(current.size, prior.size, `${prior.path} inherited size`);
      equal(current.mode, prior.mode, `${prior.path} inherited mode`);
      equal(current.sha256, prior.sha256, `${prior.path} inherited SHA-256`);
    }
  }

  const counts = {};
  for (const entry of [...manifest.entries, ...manifest.updatedEntries]) {
    verifyEntry(repositoryRoot, entry, capabilityIds);
    counts[entry.cap] = (counts[entry.cap] ?? 0) + 1;
  }
  const sortedCounts = Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareUtf8(left, right)));
  equal(JSON.stringify(sortedCounts), JSON.stringify(manifest.countsByCapability), "capability counts");
  const aggregate = JSON.stringify({ entries: manifest.entries, updatedEntries: manifest.updatedEntries });
  const identity = `sha256:${sha256(Buffer.concat([Buffer.from(DOMAIN), Buffer.from(aggregate)]))}`;
  equal(identity, manifest.ownershipAggregate.identity, "ownership aggregate");
  return {
    ok: true,
    baseFiles: base.entries.length,
    priorAddedFiles: priorEntries.length,
    addedFiles: manifest.entries.length,
    updatedFiles: manifest.updatedEntries.length,
    currentFiles: currentPaths.length,
    ownershipIdentity: identity
  };
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  const argumentIndex = process.argv.indexOf("--manifest");
  const manifestPath = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : DEFAULT_MANIFEST;
  try {
    process.stdout.write(`${JSON.stringify(verifyCapabilityOwnershipDeltaV3(manifestPath))}\n`);
  } catch (error) {
    process.stderr.write(`capability ownership delta v3 verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
