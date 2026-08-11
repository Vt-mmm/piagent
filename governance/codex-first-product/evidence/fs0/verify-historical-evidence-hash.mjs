#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TREE_ALGORITHM = "piagent-historical-tree-v1";
export const TREE_DOMAIN = `${TREE_ALGORITHM}\n`;
export const BINDING_ALGORITHM = "piagent-historical-root-bindings-v1";
export const BINDING_DOMAIN = `${BINDING_ALGORITHM}\n`;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_CONTRACT = path.join(path.dirname(SCRIPT_PATH), "historical-evidence-hash-contract.v1.json");
const DEFAULT_MAP = path.join(path.dirname(SCRIPT_PATH), "historical-evidence-map.v1.json");
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../../..");

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function renderedSha256(value) {
  return `sha256:${sha256Bytes(value)}`;
}

function canonicalMode(stat) {
  return Number(stat.mode & 0o7777n).toString(8).padStart(4, "0");
}

function checkedSize(value, label) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`unsafe size for ${label}`);
  }
  return size;
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function stableRegularFile(filePath, firstStat, relativePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(filePath, flags);
  try {
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isFile() || !sameStatIdentity(firstStat, openedBefore)) {
      throw new Error(`regular file changed before read: ${relativePath}`);
    }
    const content = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (!sameStatIdentity(openedBefore, openedAfter) || !sameStatIdentity(openedAfter, pathAfter)) {
      throw new Error(`regular file changed during read: ${relativePath}`);
    }
    if (content.length !== checkedSize(openedAfter.size, relativePath)) {
      throw new Error(`regular file length changed during read: ${relativePath}`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function stableSymlink(linkPath, firstStat, relativePath) {
  const firstTarget = fs.readlinkSync(linkPath, { encoding: "buffer" });
  const secondStat = fs.lstatSync(linkPath, { bigint: true });
  const secondTarget = fs.readlinkSync(linkPath, { encoding: "buffer" });
  if (!sameStatIdentity(firstStat, secondStat) || !firstTarget.equals(secondTarget)) {
    throw new Error(`symlink changed during read: ${relativePath}`);
  }
  return firstTarget;
}

function decodedName(nameBuffer, parentLabel) {
  const name = nameBuffer.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(nameBuffer) || name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`unsupported path name under ${parentLabel}`);
  }
  return name;
}

function rawUtf8Order(left, right) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

function scanTreeOnce(rootPath) {
  const rootBefore = fs.lstatSync(rootPath, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error(`historical root is not a real directory: ${rootPath}`);
  }

  const entries = [];
  const visit = (directoryPath, relativeDirectory) => {
    const directoryBefore = fs.lstatSync(directoryPath, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new Error(`directory changed type during scan: ${relativeDirectory || "."}`);
    }
    const namesBefore = fs.readdirSync(directoryPath, { encoding: "buffer" })
      .sort((left, right) => Buffer.compare(left, right));
    for (const nameBuffer of namesBefore) {
      const name = decodedName(nameBuffer, relativeDirectory || ".");
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = path.join(directoryPath, name);
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (stat.isFile()) {
        const content = stableRegularFile(absolutePath, stat, relativePath);
        entries.push({
          path: relativePath,
          kind: "file",
          mode: canonicalMode(stat),
          size: content.length,
          contentSha256: sha256Bytes(content)
        });
      } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          kind: "directory",
          mode: canonicalMode(stat),
          size: 0,
          contentSha256: null
        });
        visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        const target = stableSymlink(absolutePath, stat, relativePath);
        entries.push({
          path: relativePath,
          kind: "symlink",
          mode: canonicalMode(stat),
          size: target.length,
          contentSha256: sha256Bytes(target)
        });
      } else {
        throw new Error(`unsupported filesystem entry: ${relativePath}`);
      }
    }
    const namesAfter = fs.readdirSync(directoryPath, { encoding: "buffer" })
      .sort((left, right) => Buffer.compare(left, right));
    const directoryAfter = fs.lstatSync(directoryPath, { bigint: true });
    if (!sameStatIdentity(directoryBefore, directoryAfter)
      || namesBefore.length !== namesAfter.length
      || namesBefore.some((name, index) => !name.equals(namesAfter[index]))) {
      throw new Error(`directory changed during scan: ${relativeDirectory || "."}`);
    }
  };

  visit(rootPath, "");
  const rootAfter = fs.lstatSync(rootPath, { bigint: true });
  if (!sameStatIdentity(rootBefore, rootAfter)) {
    throw new Error(`historical root changed during scan: ${rootPath}`);
  }

  entries.sort(rawUtf8Order);
  const canonicalPayload = JSON.stringify(entries);
  const counts = entries.reduce((result, entry) => {
    if (entry.kind === "file") {
      result.files += 1;
      result.fileContentBytes += entry.size;
    } else if (entry.kind === "directory") {
      result.directories += 1;
    } else {
      result.symlinks += 1;
    }
    return result;
  }, { files: 0, directories: 0, symlinks: 0, fileContentBytes: 0 });
  return {
    identity: renderedSha256(Buffer.concat([Buffer.from(TREE_DOMAIN, "utf8"), Buffer.from(canonicalPayload, "utf8")])),
    entryCount: entries.length,
    ...counts
  };
}

export function computeHistoricalTreeIdentity(rootPath) {
  const first = scanTreeOnce(rootPath);
  const second = scanTreeOnce(rootPath);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`historical tree was not stable across scans: ${rootPath}`);
  }
  return first;
}

function bindingFromLegacy(entry, repositoryRoot) {
  const absoluteRoot = path.resolve(repositoryRoot, entry.localRelativePath);
  const relativeCheck = path.relative(repositoryRoot, absoluteRoot);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error(`historical root escapes repository: ${entry.id}`);
  }
  const identity = computeHistoricalTreeIdentity(absoluteRoot);
  return {
    id: entry.id,
    localRelativePath: entry.localRelativePath,
    legacyOpaqueTreeSha256: entry.treeSha256,
    canonicalTreeIdentity: identity.identity,
    files: identity.files,
    directories: identity.directories,
    symlinks: identity.symlinks,
    fileContentBytes: identity.fileContentBytes,
    entryCount: identity.entryCount,
    releaseEligible: entry.releaseEligible,
    privateRetentionRequired: entry.rawEvidenceRequiresPrivateRetention
  };
}

export function computeRootBindings(legacyMap, repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const roots = legacyMap.directories.map((entry) => bindingFromLegacy(entry, repositoryRoot))
    .sort((left, right) => Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")));
  return {
    roots,
    rootBindingListIdentity: renderedSha256(Buffer.concat([
      Buffer.from(BINDING_DOMAIN, "utf8"),
      Buffer.from(JSON.stringify(roots), "utf8")
    ]))
  };
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

export function verifyHistoricalHashContract(contractPath = DEFAULT_CONTRACT) {
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  requireEqual(contract.schemaVersion, "historical-evidence-hash-contract-v1", "schemaVersion");
  requireEqual(contract.algorithm?.id, TREE_ALGORITHM, "tree algorithm");
  requireEqual(contract.algorithm?.domainUtf8, TREE_DOMAIN, "tree domain");
  requireEqual(contract.rootBindingAggregate?.algorithm, BINDING_ALGORITHM, "binding algorithm");
  requireEqual(contract.rootBindingAggregate?.domainUtf8, BINDING_DOMAIN, "binding domain");

  const contractDirectory = path.dirname(contractPath);
  const repositoryRoot = path.resolve(contractDirectory, contract.repositoryRoot.relativePathFromContract);
  const mapPath = path.resolve(contractDirectory, contract.legacyMap.relativePathFromContract);
  const verifierPath = path.resolve(contractDirectory, contract.referenceVerifier.relativePathFromContract);
  requireEqual(sha256File(mapPath), contract.legacyMap.sha256, "legacy map SHA-256");
  requireEqual(sha256File(verifierPath), contract.referenceVerifier.sha256, "reference verifier SHA-256");

  const legacyMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const expectedLegacy = new Map(legacyMap.directories.map((entry) => [entry.id, entry]));
  requireEqual(contract.roots.length, legacyMap.directories.length, "root count");
  for (const root of contract.roots) {
    const legacy = expectedLegacy.get(root.id);
    if (!legacy) throw new Error(`contract contains unknown root: ${root.id}`);
    requireEqual(root.localRelativePath, legacy.localRelativePath, `${root.id} path`);
    requireEqual(root.legacyOpaqueTreeSha256, legacy.treeSha256, `${root.id} legacy digest`);
    requireEqual(root.files, legacy.fileCount, `${root.id} file count`);
    requireEqual(root.directories, legacy.directoryCount, `${root.id} directory count`);
    requireEqual(root.symlinks, legacy.symlinkCount, `${root.id} symlink count`);
    requireEqual(root.fileContentBytes, legacy.byteSize, `${root.id} byte count`);
    requireEqual(root.releaseEligible, false, `${root.id} release eligibility`);
    expectedLegacy.delete(root.id);
  }
  requireEqual(expectedLegacy.size, 0, "unbound legacy root count");

  const recomputed = computeRootBindings(legacyMap, repositoryRoot);
  requireEqual(JSON.stringify(recomputed.roots), JSON.stringify(contract.roots), "canonical root bindings");
  requireEqual(recomputed.rootBindingListIdentity, contract.rootBindingAggregate.identity, "root binding aggregate");
  return {
    ok: true,
    roots: contract.roots.length,
    privateRoots: contract.roots.filter((root) => root.privateRetentionRequired).length,
    releaseEligibleRoots: contract.roots.filter((root) => root.releaseEligible).length,
    rootBindingListIdentity: recomputed.rootBindingListIdentity
  };
}

function argumentValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`missing value for ${flag}`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--compute")) {
    const mapPath = argumentValue(args, "--map", DEFAULT_MAP);
    const repositoryRoot = argumentValue(args, "--repository-root", DEFAULT_REPOSITORY_ROOT);
    const legacyMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    process.stdout.write(`${JSON.stringify(computeRootBindings(legacyMap, path.resolve(repositoryRoot)), null, 2)}\n`);
    return;
  }
  const contractPath = argumentValue(args, "--contract", DEFAULT_CONTRACT);
  process.stdout.write(`${JSON.stringify(verifyHistoricalHashContract(contractPath))}\n`);
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`historical evidence hash verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
