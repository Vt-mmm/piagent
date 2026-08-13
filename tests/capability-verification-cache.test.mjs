import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  resolveCapabilityProfile
} from "../packages/piagent-core/capabilities/capability-core.js";
import {
  createCapabilityVerificationCache,
  verifyCapabilityLockCached,
  verifyProjectCapabilityStateCached
} from "../packages/piagent-core/capabilities/capability-verification-cache.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();
const loaderFiles = [
  "scripts/piagent-cli.mjs",
  "scripts/register-typescript-loader.mjs",
  "scripts/typescript-loader.mjs"
];

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-capability-cache-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureManifest() {
  return {
    apiVersion: "piagent/v1",
    kind: "CapabilityPack",
    metadata: {
      name: "test-pack",
      version: "0.1.0",
      owner: "platform-maintainers",
      lifecycle: "experimental",
      license: "MIT",
      description: "Capability cache fixture.",
      tags: ["test"]
    },
    spec: {
      coreApiVersion: 1,
      requires: { packs: [] },
      provides: {
        prompts: [{ id: "artifact", path: "artifact.txt" }],
        skills: [],
        subagents: [],
        policies: [],
        adapters: [],
        recipes: [],
        evals: []
      },
      permissions: {
        capabilities: ["filesystem-readonly"],
        filesystemRead: ["**/*"],
        filesystemWrite: [],
        networkDomains: [],
        externalActions: []
      },
      activation: { mode: "profile", profiles: ["generic"], triggers: [] },
      verification: { evalScenarios: [] }
    }
  };
}

function fixtureProfile() {
  return {
    schemaVersion: 1,
    projectId: "cache-project",
    displayName: "Cache Project",
    mode: "generic",
    rootMarkers: ["package.json"],
    protectedPaths: [".git/**"],
    requiredContext: ["README.md"],
    verifyCommands: { source: ["npm test"] },
    mcpCapabilities: ["filesystem-readonly"],
    capabilityPacks: [{ name: "test-pack", version: "0.1.0" }],
    capabilityPolicy: {
      allowedOwners: ["platform-maintainers"],
      allowedLifecycles: ["experimental"],
      allowedFilesystemRead: ["**/*"],
      allowedFilesystemWrite: [],
      allowedNetworkDomains: [],
      allowedExternalActions: []
    }
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capability-cache-"));
  temporaryRoots.add(root);
  writeJson(path.join(root, "package.json"), { name: "fixture", version: "1.0.0" });
  fs.cpSync(path.join(repositoryRoot, "packages", "piagent-core"), path.join(root, "packages", "piagent-core"), { recursive: true });
  for (const relative of loaderFiles) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relative), target);
  }
  fs.writeFileSync(path.join(root, "artifact.txt"), "fixture artifact\n");
  writeJson(path.join(root, "packs", "test-pack", "pack.json"), fixtureManifest());
  const profilePath = path.join(root, "profile.json");
  const lockPath = path.join(root, "profile.lock.json");
  writeJson(profilePath, fixtureProfile());
  const lock = resolveCapabilityProfile(root, profilePath);
  writeJson(lockPath, lock);
  return { root, profilePath, lockPath, lock };
}

function addUnselectedPack(fixture) {
  const manifest = fixtureManifest();
  manifest.metadata.name = "unselected-pack";
  manifest.spec.provides.prompts[0].id = "unselected-artifact";
  manifest.spec.provides.prompts[0].path = "unselected-artifact.txt";
  writeJson(path.join(fixture.root, "packs", "unselected-pack", "pack.json"), manifest);
  fs.writeFileSync(path.join(fixture.root, "unselected-artifact.txt"), "unselected artifact\n");
  fixture.lock = resolveCapabilityProfile(fixture.root, fixture.profilePath);
  writeJson(fixture.lockPath, fixture.lock);
}

function addUnselectedEvalPack(fixture) {
  const manifest = fixtureManifest();
  manifest.metadata.name = "eval-pack";
  manifest.spec.provides.prompts = [];
  manifest.spec.provides.evals = [{ id: "eval-case", path: "eval-case.json" }];
  writeJson(path.join(fixture.root, "packs", "eval-pack", "pack.json"), manifest);
  writeJson(path.join(fixture.root, "eval-profile.json"), { mode: "fixture" });
  fs.writeFileSync(path.join(fixture.root, "eval-fixture.txt"), "eval fixture\n");
  writeJson(path.join(fixture.root, "eval-case.json"), {
    apiVersion: "piagent/v1",
    kind: "EvalScenario",
    metadata: {
      name: "eval-case",
      version: "0.1.0",
      owner: "platform-maintainers",
      lifecycle: "experimental",
      license: "MIT",
      description: "Capability cache eval fixture.",
      tags: ["test"]
    },
    spec: {
      fixture: { path: "eval-fixture.txt" },
      profile: "eval-profile.json",
      task: "Exercise the cache.",
      expected: { verifyCommands: [], forbiddenPaths: [], forbiddenActions: [], requiredArtifacts: [] },
      budget: { maxDurationSeconds: 60, maxTokens: 1000, maxToolCalls: 10 }
    }
  });
  fixture.lock = resolveCapabilityProfile(fixture.root, fixture.profilePath);
  writeJson(fixture.lockPath, fixture.lock);
}

function verifyCached(fixture, cache, lock = fixture.lock, options = {}) {
  return verifyCapabilityLockCached(
    cache,
    fixture.root,
    fixture.profilePath,
    fixture.lockPath,
    lock,
    options
  );
}

function primeFixture() {
  const fixture = createFixture();
  const cache = createCapabilityVerificationCache();
  const first = verifyCached(fixture, cache);
  assert.equal(first.status, "current");
  assert.equal(first.cacheStatus, "verified");
  return { fixture, cache };
}

describe("capability verification metadata cache", () => {
  it("does not read or hash runtime bytes again on an unchanged cache hit", () => {
    const { fixture, cache } = primeFixture();
    const runtimeTarget = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const originalRead = fs.readFileSync;
    let runtimeReads = 0;
    fs.readFileSync = function patchedRead(file, ...args) {
      if (path.resolve(String(file)) === runtimeTarget) runtimeReads += 1;
      return originalRead.call(this, file, ...args);
    };
    try {
      const second = verifyCached(fixture, cache);
      assert.equal(second.status, "current");
      assert.equal(second.cacheStatus, "hit");
      assert.equal(runtimeReads, 0);
    } finally {
      fs.readFileSync = originalRead;
    }
  });

  it("keeps a hit when an unrelated sibling directory changes", () => {
    const { fixture, cache } = primeFixture();
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capability-cache-sibling-"));
    try {
      const result = verifyCached(fixture, cache);
      assert.equal(result.status, "current");
      assert.equal(result.cacheStatus, "hit");
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("invalidates when same-size bytes change even if mtime is restored", () => {
    const { fixture, cache } = primeFixture();
    const target = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const before = fs.statSync(target);
    const bytes = fs.readFileSync(target);
    bytes[0] = bytes[0] === 0x2f ? 0x20 : 0x2f;
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, before.atime, before.mtime);

    const result = verifyCached(fixture, cache);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "repin");
  });

  it("invalidates mode-only changes", () => {
    const { fixture, cache } = primeFixture();
    const target = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const mode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, mode === 0o600 ? 0o640 : 0o600);

    const result = verifyCached(fixture, cache);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "current");
  });

  it("invalidates inode replacement with identical bytes", () => {
    const { fixture, cache } = primeFixture();
    const target = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const replacement = `${target}.replacement`;
    fs.copyFileSync(target, replacement);
    fs.renameSync(replacement, target);

    const result = verifyCached(fixture, cache);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "current");
  });

  it("invalidates and refuses a new symbolic-link ancestor", () => {
    const { fixture, cache } = primeFixture();
    const extensions = path.join(fixture.root, "packages", "piagent-core", "extensions");
    const moved = path.join(fixture.root, "packages", "piagent-core", "extensions-real");
    fs.renameSync(extensions, moved);
    fs.symlinkSync("extensions-real", extensions, "dir");

    assert.throws(() => verifyCached(fixture, cache), /must not traverse a symbolic link/);
  });

  it("invalidates lock-document changes instead of reusing prior grants", () => {
    const { fixture, cache } = primeFixture();
    const changed = structuredClone(fixture.lock);
    changed.profile.digest = `sha256:${"f".repeat(64)}`;
    writeJson(fixture.lockPath, changed);

    const result = verifyCached(fixture, cache, changed);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "blocked");
  });

  it("invalidates profile changes instead of reusing prior consent", () => {
    const { fixture, cache } = primeFixture();
    const changed = fixtureProfile();
    changed.displayName = "Changed Cache Project";
    writeJson(fixture.profilePath, changed);

    const result = verifyCached(fixture, cache);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "blocked");
  });

  it("invalidates same-size changes in an unselected catalog artifact", () => {
    const fixture = createFixture();
    addUnselectedPack(fixture);
    const cache = createCapabilityVerificationCache();
    assert.equal(verifyCached(fixture, cache).cacheStatus, "verified");
    assert.equal(verifyCached(fixture, cache).cacheStatus, "hit");
    const target = path.join(fixture.root, "unselected-artifact.txt");
    const before = fs.statSync(target);
    const bytes = fs.readFileSync(target);
    bytes[0] = bytes[0] === 0x75 ? 0x55 : 0x75;
    fs.writeFileSync(target, bytes);
    fs.utimesSync(target, before.atime, before.mtime);

    const result = verifyCached(fixture, cache);
    assert.equal(result.cacheStatus, "verified");
    assert.equal(result.status, "repin");
  });

  it("does not cache a file changed after full verification", () => {
    const fixture = createFixture();
    const cache = createCapabilityVerificationCache();
    const target = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const bytes = fs.readFileSync(target);
    const first = verifyCached(fixture, cache, fixture.lock, {
      afterFullVerify() {
        bytes[0] = bytes[0] === 0x2f ? 0x20 : 0x2f;
        fs.writeFileSync(target, bytes);
      }
    });
    assert.equal(first.status, "current");
    assert.equal(first.cacheStatus, "verified");

    const second = verifyCached(fixture, cache);
    assert.equal(second.cacheStatus, "verified");
    assert.equal(second.status, "repin");
  });

  it("invalidates transitive profile inputs of an unselected eval", () => {
    const fixture = createFixture();
    addUnselectedEvalPack(fixture);
    const cache = createCapabilityVerificationCache();
    assert.equal(verifyCached(fixture, cache).cacheStatus, "verified");
    assert.equal(verifyCached(fixture, cache).cacheStatus, "hit");
    fs.writeFileSync(path.join(fixture.root, "eval-profile.json"), "not json\n");

    assert.throws(() => verifyCached(fixture, cache), /contains invalid JSON/);
  });

  it("re-verifies after a controlled repin instead of blessing stale bytes", () => {
    const fixture = createFixture();
    const target = path.join(fixture.root, "packages", "piagent-core", "extensions", "policy-core.js");
    const original = fs.readFileSync(target);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 0x2f ? 0x20 : 0x2f;
    fs.writeFileSync(target, changed);

    const result = verifyProjectCapabilityStateCached({
      cache: createCapabilityVerificationCache(),
      cwd: fixture.root,
      platformRoot: fixture.root,
      profilePath: fixture.profilePath,
      lockPath: fixture.lockPath,
      lockDocument: fixture.lock,
      storedProfile: fixtureProfile(),
      packageSource: () => "workspace",
      extraRoots: () => undefined,
      writeLock,
      allowRepin: true,
      forceFull: true,
      afterRepinWrite() {
        fs.writeFileSync(target, original);
      }
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /changed while the capability lock was being re-pinned/);
  });
});

function writeLock(file, value) {
  writeJson(file, value);
}
