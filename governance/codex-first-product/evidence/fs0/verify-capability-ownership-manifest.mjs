#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OWNERSHIP_ALGORITHM = "piagent-capability-ownership-manifest-v1";
export const OWNERSHIP_DOMAIN = `${OWNERSHIP_ALGORITHM}\n`;
export const PATH_LIST_ALGORITHM = "piagent-production-path-list-v1";
export const PATH_LIST_DOMAIN = `${PATH_LIST_ALGORITHM}\n`;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_MANIFEST = path.join(path.dirname(SCRIPT_PATH), "capability-module-ownership.v1.json");

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function renderedSha256(value) {
  return `sha256:${sha256Bytes(value)}`;
}

function rawUtf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validPathComponent(nameBuffer, parentLabel) {
  const name = nameBuffer.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(nameBuffer)
    || name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")) {
    throw new Error(`unsupported path name under ${parentLabel}`);
  }
  return name;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function canonicalMode(stat) {
  return Number(stat.mode & 0o7777n).toString(8).padStart(4, "0");
}

function stableFileEntry(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const relativeCheck = path.relative(repositoryRoot, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error(`production path escapes repository: ${relativePath}`);
  }
  const pathBefore = fs.lstatSync(absolutePath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`production scope entry is not a regular file: ${relativePath}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(absolutePath, flags);
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(pathBefore, openedBefore)) {
      throw new Error(`production file changed before read: ${relativePath}`);
    }
    const content = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (!sameFileIdentity(openedBefore, openedAfter) || !sameFileIdentity(openedAfter, pathAfter)) {
      throw new Error(`production file changed during read: ${relativePath}`);
    }
    if (content.length !== Number(openedAfter.size)) {
      throw new Error(`production file length changed during read: ${relativePath}`);
    }
    return {
      size: content.length,
      mode: canonicalMode(openedAfter),
      sha256: sha256Bytes(content)
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function enumerateScopePath(repositoryRoot, scopePath, destination) {
  const absolutePath = path.resolve(repositoryRoot, scopePath);
  const relativeCheck = path.relative(repositoryRoot, absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error(`scope path escapes repository: ${scopePath}`);
  }
  const stat = fs.lstatSync(absolutePath, { bigint: true });
  if (stat.isFile() && !stat.isSymbolicLink()) {
    destination.push(scopePath.split(path.sep).join("/"));
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsupported production scope root: ${scopePath}`);
  }
  const visit = (directoryPath, relativeDirectory) => {
    const names = fs.readdirSync(directoryPath, { encoding: "buffer" })
      .sort((left, right) => Buffer.compare(left, right));
    for (const nameBuffer of names) {
      const name = validPathComponent(nameBuffer, relativeDirectory);
      const absoluteChild = path.join(directoryPath, name);
      const relativeChild = `${relativeDirectory}/${name}`;
      const childStat = fs.lstatSync(absoluteChild, { bigint: true });
      if (childStat.isFile() && !childStat.isSymbolicLink()) {
        destination.push(relativeChild);
      } else if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        visit(absoluteChild, relativeChild);
      } else {
        throw new Error(`unsupported production scope entry: ${relativeChild}`);
      }
    }
  };
  visit(absolutePath, scopePath.split(path.sep).join("/"));
}

export function enumerateProductionPaths(repositoryRoot, productionModuleScope) {
  const paths = [];
  for (const scopeRoot of productionModuleScope.roots) {
    enumerateScopePath(repositoryRoot, scopeRoot, paths);
  }
  for (const rootFile of productionModuleScope.rootFiles) {
    enumerateScopePath(repositoryRoot, rootFile, paths);
  }
  paths.sort(rawUtf8Compare);
  if (new Set(paths).size !== paths.length) {
    throw new Error("production scope contains duplicate paths");
  }
  return paths;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function countsByCapability(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.cap] = (counts[entry.cap] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => rawUtf8Compare(left, right)));
}

function canonicalOwnershipIdentity(entries) {
  return renderedSha256(Buffer.concat([
    Buffer.from(OWNERSHIP_DOMAIN, "utf8"),
    Buffer.from(JSON.stringify(entries), "utf8")
  ]));
}

function canonicalPathListIdentity(paths) {
  return renderedSha256(Buffer.concat([
    Buffer.from(PATH_LIST_DOMAIN, "utf8"),
    Buffer.from(JSON.stringify(paths), "utf8")
  ]));
}

export function verifyCapabilityOwnershipManifest(manifestPath = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  requireEqual(manifest.schemaVersion, "capability-module-ownership-v1", "schemaVersion");
  requireEqual(manifest.ownershipAggregate?.algorithm, OWNERSHIP_ALGORITHM, "ownership algorithm");
  requireEqual(manifest.ownershipAggregate?.domainUtf8, OWNERSHIP_DOMAIN, "ownership domain");
  requireEqual(manifest.pathList?.algorithm, PATH_LIST_ALGORITHM, "path-list algorithm");
  requireEqual(manifest.pathList?.domainUtf8, PATH_LIST_DOMAIN, "path-list domain");
  requireEqual(manifest.repositoryRoot?.relativePathFromManifest, "../../../..", "repository root locator");
  requireEqual(manifest.constitution?.relativePathFromManifest, "capability-constitution.v1.json", "constitution locator");
  requireEqual(manifest.referenceVerifier?.relativePathFromManifest, "verify-capability-ownership-manifest.mjs", "verifier locator");

  const manifestDirectory = path.dirname(manifestPath);
  const repositoryRoot = path.resolve(manifestDirectory, manifest.repositoryRoot.relativePathFromManifest);
  const constitutionPath = path.resolve(manifestDirectory, manifest.constitution.relativePathFromManifest);
  const verifierPath = path.resolve(manifestDirectory, manifest.referenceVerifier.relativePathFromManifest);
  requireEqual(sha256File(constitutionPath), manifest.constitution.sha256, "constitution SHA-256");
  requireEqual(sha256File(verifierPath), manifest.referenceVerifier.sha256, "reference verifier SHA-256");

  const constitution = JSON.parse(fs.readFileSync(constitutionPath, "utf8"));
  const currentPaths = enumerateProductionPaths(repositoryRoot, constitution.productionModuleScope);
  requireEqual(currentPaths.length, manifest.entries.length, "manifest path count");
  requireEqual(manifest.entries.length, manifest.totalFiles, "declared file count");

  const capabilities = new Set(constitution.capabilities.map((capability) => capability.id));
  const seen = new Set();
  const expectedEntryKeys = ["path", "cap", "size", "mode", "sha256"];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    requireEqual(JSON.stringify(Object.keys(entry)), JSON.stringify(expectedEntryKeys), `entry key order ${index}`);
    requireEqual(entry.path, currentPaths[index], `entry path ${index}`);
    if (seen.has(entry.path)) throw new Error(`duplicate ownership path: ${entry.path}`);
    seen.add(entry.path);
    if (!capabilities.has(entry.cap)) throw new Error(`unknown capability for ${entry.path}: ${entry.cap}`);
    const current = stableFileEntry(repositoryRoot, entry.path);
    requireEqual(entry.size, current.size, `${entry.path} size`);
    requireEqual(entry.mode, current.mode, `${entry.path} mode`);
    requireEqual(entry.sha256, current.sha256, `${entry.path} content SHA-256`);
  }

  const counts = countsByCapability(manifest.entries);
  requireEqual(JSON.stringify(counts), JSON.stringify(manifest.countsByCapability), "manifest capability counts");
  requireEqual(JSON.stringify(counts), JSON.stringify(constitution.coverageProof.countsByCapability), "constitution capability counts");
  requireEqual(Object.keys(counts).length, constitution.capabilities.length, "covered capability count");

  const legacyPathListSha256 = sha256Bytes(JSON.stringify(currentPaths));
  requireEqual(legacyPathListSha256, constitution.coverageProof.coveredPathListSha256, "constitution path-list SHA-256");
  requireEqual(legacyPathListSha256, manifest.pathList.legacyBareSha256, "manifest legacy path-list SHA-256");
  requireEqual(canonicalPathListIdentity(currentPaths), manifest.pathList.identity, "canonical path-list identity");
  requireEqual(canonicalOwnershipIdentity(manifest.entries), manifest.ownershipAggregate.identity, "ownership aggregate");

  const reconstructedLegacyBare = sha256Bytes(JSON.stringify(manifest.entries));
  requireEqual(reconstructedLegacyBare, manifest.legacyOwnershipAggregate.reconstructedBareSha256, "reconstructed legacy bare aggregate");
  requireEqual(constitution.coverageProof.coveredContentOwnershipManifestSha256, manifest.legacyOwnershipAggregate.constitutionClaimedBareSha256, "constitution claimed aggregate binding");
  requireEqual(manifest.legacyOwnershipAggregate.equalityClaim, false, "legacy aggregate equality claim");
  return {
    ok: true,
    files: manifest.entries.length,
    capabilities: Object.keys(counts).length,
    unowned: 0,
    duplicateOwners: 0,
    pathListIdentity: manifest.pathList.identity,
    ownershipIdentity: manifest.ownershipAggregate.identity
  };
}

function argumentValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`missing value for ${flag}`);
  return args[index + 1];
}

async function main() {
  const manifestPath = argumentValue(process.argv.slice(2), "--manifest", DEFAULT_MANIFEST);
  process.stdout.write(`${JSON.stringify(verifyCapabilityOwnershipManifest(manifestPath))}\n`);
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`capability ownership verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
