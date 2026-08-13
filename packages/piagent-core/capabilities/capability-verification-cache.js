import fs from "node:fs";
import path from "node:path";

import { sha256, stableJson, verifyCapabilityLock } from "./capability-core.js";
import { resolveProjectProfileDocument } from "./project-profile.js";

const compare = (left, right) => String(left).localeCompare(String(right), "en");
const MAX_PACK_ENTRIES = 256;
const MAX_ARTIFACTS_PER_KIND = 128;
const MAX_JSON_BYTES = 256 * 1024;

// Full capability resolution deliberately hashes every executable runtime file.
// That is the right cold-path check, but not useful per-call work. This cache
// remembers only a `current` full verification. Reuse still walks strong
// metadata for every input that produced it; any change or error falls back to
// the cryptographic verifier.
export function createCapabilityVerificationCache() {
  return new Map();
}

function cacheRootForPack(rootReal, pack, extraRoots) {
  return pack.origin === "workspace"
    ? rootReal
    : extraRoots.find((entry) => entry.origin === pack.origin)?.root;
}

function addTarget(targets, target, kind, optional = false) {
  const absolute = path.resolve(target);
  const previous = targets.get(absolute);
  if (!previous || previous.kind !== "directory") targets.set(absolute, { path: absolute, kind, optional });
}

function containedTarget(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) return undefined;
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : absolute;
}

function readBoundedJson(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function addEvalInputs(targets, packRoot, artifactPath) {
  const artifact = readBoundedJson(artifactPath);
  const profile = containedTarget(packRoot, artifact?.spec?.profile);
  const fixture = containedTarget(packRoot, artifact?.spec?.fixture?.path);
  if (!profile || !fixture) return false;
  addTarget(targets, profile, "file");
  addTarget(targets, fixture, "file");
  return true;
}

function addCatalogTargets(targets, packRoot) {
  const packsDirectory = path.join(packRoot, "packs");
  addTarget(targets, packsDirectory, "directory");
  const entries = fs.readdirSync(packsDirectory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."));
  if (entries.length > MAX_PACK_ENTRIES) return false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink?.()) return false;
    const packDirectory = path.join(packsDirectory, entry.name);
    addTarget(targets, packDirectory, "directory");
    const manifestPath = path.join(packDirectory, "pack.json");
    addTarget(targets, manifestPath, "file");
    const manifest = readBoundedJson(manifestPath);
    const provides = manifest?.spec?.provides;
    if (!provides || typeof provides !== "object" || Array.isArray(provides)) return false;
    for (const [kind, artifacts] of Object.entries(provides)) {
      if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS_PER_KIND) return false;
      for (const artifact of artifacts) {
        const target = containedTarget(packRoot, artifact?.path);
        if (!target) return false;
        addTarget(targets, target, "file");
        if (kind === "evals" && !addEvalInputs(targets, packRoot, target)) return false;
      }
    }
  }
  return true;
}

function verificationTargets(root, profilePath, lockPath, document, options = {}) {
  const rootReal = fs.realpathSync(root);
  const targets = new Map();
  addTarget(targets, profilePath, "file");
  addTarget(targets, lockPath, "file");
  for (const target of options.identityFiles ?? []) addTarget(targets, target, "file", true);

  const extraRoots = options.extraRoots ?? [];
  const packRoots = new Map();
  for (const pack of document?.packs ?? []) {
    const packRoot = cacheRootForPack(rootReal, pack, extraRoots);
    if (!packRoot) continue;
    packRoots.set(`${pack.name}@${pack.version}`, packRoot);
    addTarget(targets, path.join(packRoot, "packs"), "directory");
    addTarget(targets, path.join(packRoot, "packs", pack.name), "directory");
    addTarget(targets, path.join(packRoot, "packs", pack.name, "pack.json"), "file");
  }
  for (const entry of extraRoots) {
    addTarget(targets, entry.root, "directory");
    addTarget(targets, path.join(entry.root, "packs"), "directory");
  }
  for (const packRoot of [rootReal, ...extraRoots.map((entry) => entry.root)]) {
    if (!addCatalogTargets(targets, packRoot)) return undefined;
  }
  for (const entry of document?.core?.runtimeFiles ?? []) {
    const target = containedTarget(rootReal, entry.path);
    if (!target) return undefined;
    addTarget(targets, target, "file");
  }
  for (const artifact of document?.artifacts ?? []) {
    const artifactRoot = packRoots.get(artifact.pack);
    if (!artifactRoot) continue;
    const target = containedTarget(artifactRoot, artifact.path);
    if (!target) return undefined;
    addTarget(targets, target, "file");
  }
  return [...targets.values()].sort((left, right) => compare(left.path, right.path));
}

function statIdentity(stat, includeTimes) {
  const values = [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev, stat.size];
  if (includeTimes) values.push(stat.mtimeNs, stat.ctimeNs);
  return values.map(String).join(":");
}

function ancestorIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.rdev]
    .map(String)
    .join(":");
}

function lexicalAncestors(target) {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const ancestors = [];
  let current = parsed.root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    ancestors.push(current);
  }
  return ancestors;
}

function metadataSignature(targets) {
  if (!targets) return undefined;
  const records = [];
  const ancestors = new Set(targets.flatMap((target) => lexicalAncestors(target.path)));
  try {
    for (const ancestor of [...ancestors].sort(compare)) {
      const stat = fs.lstatSync(ancestor, { bigint: true });
      const symbolic = stat.isSymbolicLink();
      const identity = symbolic ? statIdentity(stat, true) : ancestorIdentity(stat);
      records.push(`a:${ancestor}:${identity}:${symbolic ? fs.readlinkSync(ancestor) : "directory"}`);
    }
    for (const target of targets) {
      let lexical;
      try {
        lexical = fs.lstatSync(target.path, { bigint: true });
      } catch (error) {
        if (target.optional && error?.code === "ENOENT") {
          records.push(`t:${target.path}:absent`);
          continue;
        }
        return undefined;
      }
      const expectedType = target.kind === "directory" ? lexical.isDirectory() : lexical.isFile();
      if (!expectedType || lexical.isSymbolicLink()) return undefined;
      records.push(`t:${target.path}:${statIdentity(lexical, true)}`);
    }
  } catch {
    return undefined;
  }
  return sha256(records.join("\n"));
}

const cacheKey = (root, profilePath, lockPath) => (
  `${path.resolve(root)}\0${path.resolve(profilePath)}\0${path.resolve(lockPath)}`
);

function cacheIdentity(lockDocument, options = {}) {
  return sha256(stableJson({
    lockDocument,
    packageSource: options.packageSource,
    extraRoots: (options.extraRoots ?? []).map((entry) => ({ origin: entry.origin, root: entry.root, source: entry.source })),
    identityFiles: (options.identityFiles ?? []).map((entry) => path.resolve(entry)).sort(compare)
  }));
}

function snapshotTargets(targets) {
  const signature = metadataSignature(targets);
  return signature ? { signature, targets } : undefined;
}

function stableSnapshot(snapshot) {
  if (!snapshot) return false;
  const current = metadataSignature(snapshot.targets);
  return Boolean(current && current === snapshot.signature);
}

export function verifyCapabilityLockCached(cache, root, profilePath, lockPath, lockDocument, options = {}) {
  const key = cacheKey(root, profilePath, lockPath);
  const identity = cacheIdentity(lockDocument, options);
  const cached = options.forceFull === true ? undefined : cache?.get(key);
  if (cached?.identity === identity) {
    const signature = metadataSignature(cached.targets);
    if (signature && signature === cached.signature) return { ...cached.verification, cacheStatus: "hit" };
  }
  cache?.delete(key);

  const initialTargets = verificationTargets(root, profilePath, lockPath, lockDocument, options);
  const before = snapshotTargets(initialTargets);
  const verification = verifyCapabilityLock(root, profilePath, lockDocument, options);
  options.afterFullVerify?.();
  if (verification.status === "current" && before) {
    const after = snapshotTargets(verificationTargets(root, profilePath, lockPath, verification.expected, options));
    if (after && before.signature === after.signature && stableSnapshot(after)) {
      cache?.set(key, { identity, ...after, verification });
    }
  }
  return { ...verification, cacheStatus: "verified" };
}

export function verifyProjectCapabilityStateCached(input) {
  const { cache, cwd, platformRoot, profilePath, lockPath, lockDocument, storedProfile } = input;
  const profile = resolveProjectProfileDocument(platformRoot, storedProfile).profile;
  if (!Array.isArray(profile.capabilityPacks)) return { ok: true };
  const packageSource = input.packageSource(cwd);
  const extraRoots = input.extraRoots(cwd, profile);
  const identityFiles = [path.join(cwd, ".pi", "settings.json")];
  if (typeof storedProfile.extends === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(storedProfile.extends)) {
    identityFiles.push(path.join(platformRoot, "adapters", storedProfile.extends, "profile.json"));
  }
  const verificationOptions = { packageSource, extraRoots, identityFiles, forceFull: input.forceFull === true };
  const verification = verifyCapabilityLockCached(cache, platformRoot, profilePath, lockPath, lockDocument, verificationOptions);
  const runtimeDigest = verification.expected?.core?.packageDigest;
  if (input.allowRepin !== true && input.sessionDigest && runtimeDigest !== input.sessionDigest) {
    return { ok: false, reason: "Installed Piagent runtime changed during this session. Restart the session to verify and re-pin the capability lock before using tools." };
  }
  if (verification.status === "repin" && input.allowRepin !== true) {
    return { ok: false, reason: "Installed Piagent runtime changed during this session. Restart the session to verify and re-pin the capability lock before using tools." };
  }
  if (verification.status === "blocked") {
    return { ok: false, reason: `Capability lock does not match what this project agreed to: ${verification.reasons.join("; ")}. Reapply the project profile.` };
  }
  const granted = {
    filesystemRead: verification.expected.permissions.filesystemRead,
    filesystemWrite: verification.expected.permissions.filesystemWrite
  };
  if (verification.status !== "repin") {
    if (input.allowRepin === true) input.rememberSessionDigest?.(runtimeDigest);
    return { ok: true, ...granted };
  }

  try {
    input.writeLock(lockPath, verification.expected);
  } catch (error) {
    return { ok: false, reason: `Capability lock is behind the installed platform and could not be rewritten: ${error instanceof Error ? error.message : String(error)}` };
  }
  input.afterRepinWrite?.();
  const confirmed = verifyCapabilityLockCached(
    cache,
    platformRoot,
    profilePath,
    lockPath,
    verification.expected,
    { ...verificationOptions, forceFull: true }
  );
  if (confirmed.status !== "current") {
    return { ok: false, reason: "Installed Piagent runtime changed while the capability lock was being re-pinned. Restart the session and try again." };
  }
  input.rememberSessionDigest?.(runtimeDigest);
  return { ok: true, repinned: verification.reasons.join("; "), ...granted };
}
