import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import {
  CapabilityValidationError,
  buildCapabilityCatalog,
  classifyCapabilityLock,
  resolveCapabilityProfile,
  stableJson,
  validateCapabilityPack,
  validateCapabilityPackageSource,
  validateCapabilityRecipe,
  validateExternalActionProposal,
  verifyCapabilityLock,
  writeJsonAtomic,
  writeProfileLockAtomic
} from "../packages/piagent-core/capabilities/capability-core.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const actionValidationNow = Date.parse("2026-07-21T01:30:00.000Z");
const temporaryRoots = new Set();
const CONTROL_BOUNDARY_INTEGRITY_FILES = Object.freeze([
  "packages/piagent-core/capabilities/capability-verification-cache.js",
  "packages/piagent-core/extensions/document-intake.ts",
  "packages/piagent-core/extensions/execution-backend.js",
  "packages/piagent-core/extensions/state-retention.js",
  "packages/piagent-core/extensions/task-state.js",
  "packages/piagent-core/extensions/verification-intelligence.js",
  "scripts/piagent-cli.mjs",
  "scripts/register-typescript-loader.mjs",
  "scripts/typescript-loader.mjs"
]);

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-capability-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function baseManifest(name = "test-pack") {
  return {
    apiVersion: "piagent/v1",
    kind: "CapabilityPack",
    metadata: {
      name,
      version: "0.1.0",
      owner: "platform-maintainers",
      lifecycle: "experimental",
      license: "MIT",
      description: "A bounded test capability pack.",
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
      activation: {
        mode: "profile",
        profiles: ["generic"],
        triggers: []
      },
      verification: { evalScenarios: [] }
    }
  };
}

/** A lock document reduced to the fields the classifier reads. */
function lockDocument(origin, artifactDigest) {
  return {
    schemaVersion: 1,
    core: { apiVersion: 1, packageSource: "npm:@piagent/platform@1.0.0", packageVersion: "1.0.0" },
    profile: { projectId: "p", mode: "generic", file: "piagent-profile.json", digest: "sha256:profile" },
    packs: [{
      name: "acme", version: "0.1.0", origin, source: "src",
      owner: "platform-maintainers", lifecycle: "stable", digest: "sha256:manifest"
    }],
    permissions: {
      capabilities: [], filesystemRead: [], filesystemWrite: [], networkDomains: [], externalActions: [],
      protectedPaths: [], readOnlyPaths: [], shellProtectedPaths: []
    },
    artifacts: [{ pack: "acme@0.1.0", kind: "prompts", id: "a", path: "a.txt", digest: artifactDigest }]
  };
}

function baseProfile() {
  return {
    schemaVersion: 1,
    projectId: "test-project",
    displayName: "Test Project",
    mode: "generic",
    rootMarkers: ["package.json"],
    protectedPaths: [".git/**", "**/.env"],
    requiredContext: ["README.md"],
    verifyCommands: { source: ["npm test"] },
    mcpCapabilities: ["filesystem-readonly"],
    capabilityPacks: [{ name: "test-pack", version: "0.1.0" }],
    capabilityPolicy: {
      allowedOwners: ["platform-maintainers"],
      allowedLifecycles: ["experimental"],
      allowedFilesystemRead: ["**/*"],
      allowedFilesystemWrite: ["**/*"],
      allowedNetworkDomains: [],
      allowedExternalActions: []
    }
  };
}

function createPlatformFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capability-"));
  temporaryRoots.add(root);
  writeJson(path.join(root, "package.json"), { name: "fixture", version: "1.0.2" });
  fs.cpSync(path.join(repositoryRoot, "packages", "piagent-core"), path.join(root, "packages", "piagent-core"), { recursive: true });
  for (const relativePath of CONTROL_BOUNDARY_INTEGRITY_FILES.filter((entry) => entry.startsWith("scripts/"))) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), target);
  }
  fs.writeFileSync(path.join(root, "artifact.txt"), "bounded artifact\n");
  writeJson(path.join(root, "packs", "test-pack", "pack.json"), baseManifest());
  writeJson(path.join(root, "profile.json"), baseProfile());
  return root;
}

function filesBelow(root, relativeDirectory) {
  const files = [];
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    }
  };
  visit(relativeDirectory);
  return files.sort();
}

function validActionProposal() {
  return {
    apiVersion: "piagent/v1",
    kind: "ExternalActionProposal",
    metadata: {
      name: "publish-change",
      createdAt: "2026-07-21T01:00:00.000Z",
      expiresAt: "2026-07-21T02:00:00.000Z"
    },
    spec: {
      actionType: "github-pull-request",
      target: {
        provider: "github",
        resource: "organization/repository"
      },
      summary: "Create a pull request for an approved workspace diff.",
      riskLane: "high-risk",
      requestedPermissions: ["github:pull-requests-write"],
      artifacts: [{
        path: "artifacts/change.patch",
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "text/x-diff",
        byteSize: 1024
      }],
      dryRun: true,
      security: {
        containsSecrets: false
      }
    }
  };
}

describe("capability catalog and profile lock", () => {
  it("builds deterministic catalog output", () => {
    const first = stableJson(buildCapabilityCatalog(repositoryRoot));
    const second = stableJson(buildCapabilityCatalog(repositoryRoot));
    assert.equal(first, second);
    assert.equal(JSON.parse(first).packs.length, 2);
  });

  it("resolves exact dependencies and verifies a current lock", () => {
    const profile = path.join(repositoryRoot, "adapters", "web-frontend", "profile.json");
    const lock = resolveCapabilityProfile(repositoryRoot, profile);
    assert.deepEqual(lock.packs.map((pack) => pack.name), ["engineering-base", "web-delivery"]);
    assert.equal(verifyCapabilityLock(repositoryRoot, profile, lock).ok, true);
    assert.equal(lock.permissions.protectedPaths.includes(".pi/piagent-profile.lock.json"), true);
    assert.equal(lock.permissions.protectedPaths.includes(".pi/context-index.json"), true);
    assert.equal(lock.permissions.shellProtectedPaths.includes(".pi/piagent-state/**"), true);
    assert.equal(lock.permissions.shellProtectedPaths.includes(".pi/context-index.json"), true);
    assert.ok(
      lock.core.runtimeFiles.some((entry) => entry.path === "packages/piagent-core/extensions/context-engine.js"),
      "the profile lock must pin the context engine runtime"
    );
    assert.ok(
      lock.core.runtimeFiles.some((entry) => entry.path === "packages/piagent-core/extensions/context-index-policy.js"),
      "the profile lock must pin the context index policy runtime"
    );
    assert.ok(
      lock.core.runtimeFiles.some((entry) => entry.path === "packages/piagent-core/capabilities/runtime-integrity.js"),
      "the profile lock must pin the runtime integrity manifest"
    );
    assert.ok(
      lock.core.runtimeFiles.some((entry) => entry.path === "packages/piagent-core/extensions/task-runtime-audit.js"),
      "the profile lock must pin current-tree verifier checkpoint identity"
    );
    const pinnedRuntimeFiles = new Set(lock.core.runtimeFiles.map((entry) => entry.path));
    assert.deepEqual(
      CONTROL_BOUNDARY_INTEGRITY_FILES.filter((entry) => !pinnedRuntimeFiles.has(entry)),
      [],
      "the profile lock must pin every task-decision and TypeScript-loader control boundary"
    );
    assert.deepEqual(
      lock.core.runtimeFiles
        .map((entry) => entry.path)
        .filter((entry) => entry.includes("model-mutation-proof") || entry.includes("performance-review"))
        .sort(),
      [
        "packages/piagent-core/runtime/quality/model-mutation-proof.ts",
        "packages/piagent-core/runtime/quality/performance-review-evidence.ts",
        "packages/piagent-core/runtime/session/performance-review-state.ts"
      ],
      "the profile lock must pin every performance-review enforcement module"
    );
    assert.deepEqual(
      lock.core.runtimeFiles
        .map((entry) => entry.path)
        .filter((entry) => entry.startsWith("packages/piagent-core/runtime/"))
        .sort(),
      filesBelow(repositoryRoot, "packages/piagent-core/runtime"),
      "every executable runtime module must be pinned by the profile lock"
    );
  });

  it("binds a lock to its declared package source", () => {
    const profile = path.join(repositoryRoot, "adapters", "generic", "profile.json");
    const lock = resolveCapabilityProfile(repositoryRoot, profile, { packageSource: "npm:@piagent/platform@0.3.23" });
    assert.equal(verifyCapabilityLock(repositoryRoot, profile, lock, { packageSource: "npm:@piagent/platform@0.3.23" }).ok, true);
    assert.equal(verifyCapabilityLock(repositoryRoot, profile, lock, { packageSource: "npm:@piagent/platform@0.3.24" }).ok, false);
  });

  it("detects a stale profile lock", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);
    const profile = baseProfile();
    profile.displayName = "Updated Project";
    writeJson(profilePath, profile);
    assert.equal(verifyCapabilityLock(root, profilePath, lock).ok, false);
  });

  // A platform build moves on every release. When the grant it resolves to is
  // the same, the lock records the new build rather than stopping the project,
  // which is what put a per-project step behind a global update.
  it("re-pins a runtime file change that grants nothing new", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);
    fs.appendFileSync(path.join(root, "packages", "piagent-core", "extensions", "policy-core.js"), "\n// integrity change\n");
    const verification = verifyCapabilityLock(root, profilePath, lock);
    assert.equal(verification.status, "repin");
    assert.equal(verification.ok, true);
  });

  it("re-pins every task-decision and TypeScript-loader control change", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);
    for (const relativePath of CONTROL_BOUNDARY_INTEGRITY_FILES) {
      const target = path.join(root, relativePath);
      const original = fs.readFileSync(target);
      fs.appendFileSync(target, "\n// control-boundary mutation\n");
      assert.equal(verifyCapabilityLock(root, profilePath, lock).status, "repin", relativePath);
      fs.writeFileSync(target, original);
      assert.equal(verifyCapabilityLock(root, profilePath, lock).status, "current", relativePath);
    }
  });

  it("re-pins a base policy change that only reformats it", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);
    fs.appendFileSync(path.join(root, "packages", "piagent-core", "policies", "base-policy.json"), "\n");
    assert.equal(verifyCapabilityLock(root, profilePath, lock).status, "repin");
  });

  // The previous version of these two tests appended whitespace and asserted the
  // lock refused. They passed because any byte anywhere refused, not because a
  // weakened policy was noticed — the case below is the one that matters.
  it("refuses a base policy that stops covering a protected path", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);

    const basePolicyPath = path.join(root, "packages", "piagent-core", "policies", "base-policy.json");
    const basePolicy = JSON.parse(fs.readFileSync(basePolicyPath, "utf8"));
    const dropped = basePolicy.protectedPaths.pop();
    writeJson(basePolicyPath, basePolicy);

    const verification = verifyCapabilityLock(root, profilePath, lock);
    assert.equal(verification.status, "blocked");
    assert.equal(verification.ok, false);
    assert.ok(verification.reasons.some((reason) => reason.includes(dropped)), verification.reasons.join("; "));
  });

  it("refuses a platform that would grant more than the lock agreed to", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);

    // Drop one entry the fixture really grants, so the assertion cannot hold
    // just because the list was empty.
    const granted = ["capabilities", "filesystemRead", "filesystemWrite", "networkDomains", "externalActions"]
      .find((key) => (lock.permissions[key] ?? []).length > 0);
    assert.ok(granted, `the fixture grants nothing: ${stableJson(lock.permissions)}`);

    const narrower = JSON.parse(JSON.stringify(lock));
    const removed = narrower.permissions[granted].pop();
    const verification = verifyCapabilityLock(root, profilePath, narrower);
    assert.equal(verification.status, "blocked");
    assert.ok(
      verification.reasons.some((reason) => reason === `${granted} would grant ${removed}`),
      verification.reasons.join("; ")
    );
  });

  it("refuses a lock whose pack set no longer matches", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);

    const swapped = JSON.parse(JSON.stringify(lock));
    swapped.packs[0].digest = `sha256:${"b".repeat(64)}`;
    const verification = verifyCapabilityLock(root, profilePath, swapped);
    assert.equal(verification.status, "blocked");
    assert.ok(verification.reasons.some((reason) => reason.startsWith("packs")), verification.reasons.join("; "));
  });

  it("reports an untouched lock as current", () => {
    const root = createPlatformFixture();
    const profilePath = path.join(root, "profile.json");
    const lock = resolveCapabilityProfile(root, profilePath);
    assert.equal(verifyCapabilityLock(root, profilePath, lock).status, "current");
  });
});

describe("capability input boundaries", () => {
  it("requires exact references for remote package sources", () => {
    assert.equal(validateCapabilityPackageSource("git:github.com/Vt-mmm/piagent@v0.3.23"), "git:github.com/Vt-mmm/piagent@v0.3.23");
    assert.equal(validateCapabilityPackageSource("npm:@example-org/platform@0.3.23"), "npm:@example-org/platform@0.3.23");
    assert.equal(validateCapabilityPackageSource("https://github.com/Vt-mmm/piagent/archive/refs/tags/v0.3.23.tar.gz"), "https://github.com/Vt-mmm/piagent/archive/refs/tags/v0.3.23.tar.gz");
    assert.throws(() => validateCapabilityPackageSource("https://github.com/Vt-mmm/piagent"), /exact tag/);
    assert.throws(() => validateCapabilityPackageSource("git:github.com/Vt-mmm/piagent"), /exact tag/);
    assert.throws(() => validateCapabilityPackageSource("npm:@example-org/platform@latest"), /exact version/);
    assert.throws(() => validateCapabilityPackageSource("npm:..@1.2.3"), /valid lowercase/);
    assert.throws(() => validateCapabilityPackageSource("npm:@../pkg@1.2.3"), /valid lowercase/);
    assert.throws(() => validateCapabilityPackageSource("npm:--help@1.2.3"), /valid lowercase/);
    assert.throws(() => validateCapabilityPackageSource("git:@v0.3.23"), /host\/repository/);
    assert.throws(() => validateCapabilityPackageSource("git:example.com/repo name@v0.3.23"), /host\/repository/);
    assert.throws(() => validateCapabilityPackageSource("git:../repo@v0.3.23"), /host\/repository/);
    assert.throws(() => validateCapabilityPackageSource("git:./repo@v0.3.23"), /host\/repository/);
    assert.throws(() => validateCapabilityPackageSource("git:-option/repo@v0.3.23"), /host\/repository/);
    assert.throws(() => validateCapabilityPackageSource("https://example.com/repo name@v0.3.23"), /whitespace-free/);
    assert.throws(() => validateCapabilityPackageSource("https://example.com/../repo@v0.3.23"), /repository path/);
    assert.throws(() => validateCapabilityPackageSource("https://example.com/-option/repo@v0.3.23"), /repository path/);
    assert.throws(() => validateCapabilityPackageSource("https://example.com/repo@v0.3.23?channel=latest"), /repository path/);
  });

  it("requires metadata tags and caps exact dependencies", () => {
    const missingTags = baseManifest();
    delete missingTags.metadata.tags;
    assert.throws(() => validateCapabilityPack(missingTags), CapabilityValidationError);

    const excessiveDependencies = baseManifest();
    excessiveDependencies.spec.requires.packs = Array.from({ length: 65 }, (_item, index) => ({ name: `dependency-${index}`, version: "0.1.0" }));
    assert.throws(
      () => validateCapabilityPack(excessiveDependencies),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("at most 64"))
    );
  });

  it("rejects an artifact path outside the repository", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.provides.prompts[0].path = "../outside.txt";
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    assert.throws(() => buildCapabilityCatalog(root), CapabilityValidationError);
  });

  it("rejects artifact paths that traverse a symbolic link", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.provides.prompts[0].path = "packs/test-pack/artifact-link.txt";
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    fs.symlinkSync(path.join(root, "artifact.txt"), path.join(root, "packs", "test-pack", "artifact-link.txt"));
    assert.throws(() => buildCapabilityCatalog(root), /symbolic link/);
  });

  it("rejects dependency cycles", () => {
    const root = createPlatformFixture();
    const first = baseManifest("first-pack");
    first.spec.provides.prompts[0].id = "first-artifact";
    first.spec.requires.packs = [{ name: "second-pack", version: "0.1.0" }];
    const second = baseManifest("second-pack");
    second.spec.provides.prompts[0].id = "second-artifact";
    second.spec.requires.packs = [{ name: "first-pack", version: "0.1.0" }];
    fs.rmSync(path.join(root, "packs", "test-pack"), { recursive: true });
    writeJson(path.join(root, "packs", "first-pack", "pack.json"), first);
    writeJson(path.join(root, "packs", "second-pack", "pack.json"), second);
    assert.throws(() => buildCapabilityCatalog(root), /dependency graph/);
  });

  it("rejects duplicate artifact identifiers across packs", () => {
    const root = createPlatformFixture();
    const first = baseManifest("first-pack");
    const second = baseManifest("second-pack");
    fs.rmSync(path.join(root, "packs", "test-pack"), { recursive: true });
    writeJson(path.join(root, "packs", "first-pack", "pack.json"), first);
    writeJson(path.join(root, "packs", "second-pack", "pack.json"), second);
    assert.throws(
      () => buildCapabilityCatalog(root),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("artifact ids must be globally unique"))
    );
  });

  it("requires every artifact collection declared by the schema", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    delete manifest.spec.provides.evals;
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    assert.throws(() => buildCapabilityCatalog(root), /is invalid/);
  });

  it("rejects an eval scenario binding outside the dependency graph", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.verification.evalScenarios = ["missing-scenario"];
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    assert.throws(
      () => buildCapabilityCatalog(root),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("eval scenario missing-scenario"))
    );
  });

  it("rejects cycles between recipe artifacts", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.provides.recipes = [
      { id: "recipe-a", path: "recipes/recipe-a.json" },
      { id: "recipe-b", path: "recipes/recipe-b.json" }
    ];
    const recipeTemplate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packs", "engineering-base", "recipes", "bounded-change.json"), "utf8"));
    const recipeA = structuredClone(recipeTemplate);
    recipeA.metadata.name = "recipe-a";
    recipeA.spec.steps = [{ id: "run-b", uses: "recipe:recipe-b", mode: "workspace-write", needs: [], timeoutSeconds: 60, retries: 0, outputs: [] }];
    const recipeB = structuredClone(recipeTemplate);
    recipeB.metadata.name = "recipe-b";
    recipeB.spec.steps = [{ id: "run-a", uses: "recipe:recipe-a", mode: "workspace-write", needs: [], timeoutSeconds: 60, retries: 0, outputs: [] }];
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    writeJson(path.join(root, "recipes", "recipe-a.json"), recipeA);
    writeJson(path.join(root, "recipes", "recipe-b.json"), recipeB);
    assert.throws(
      () => buildCapabilityCatalog(root),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("dependency cycle detected"))
    );
  });

  it("rejects capability escalation beyond the profile grant", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.permissions.capabilities.push("browser");
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    assert.throws(() => resolveCapabilityProfile(root, path.join(root, "profile.json")), /does not grant required capability browser/);
  });

  it("rejects network access not allowed by the profile", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.permissions.networkDomains.push("api.example.com");
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    assert.throws(() => resolveCapabilityProfile(root, path.join(root, "profile.json")), /does not allow network domain/);
  });

  it("rejects filesystem scope not allowed by the profile", () => {
    const root = createPlatformFixture();
    const manifest = baseManifest();
    manifest.spec.permissions.filesystemWrite = ["src/**"];
    writeJson(path.join(root, "packs", "test-pack", "pack.json"), manifest);
    const profile = baseProfile();
    profile.capabilityPolicy.allowedFilesystemWrite = [];
    writeJson(path.join(root, "profile.json"), profile);
    assert.throws(() => resolveCapabilityProfile(root, path.join(root, "profile.json")), /does not allow filesystem write scope/);
  });

  it("rejects writes through a symbolic-link output", () => {
    const root = createPlatformFixture();
    const target = path.join(root, "catalog.json");
    fs.symlinkSync(path.join(root, "artifact.txt"), target);
    assert.throws(() => writeJsonAtomic(target, { ok: true }), /symbolic link/);
  });

  it("does not replace a profile when its lock target is unsafe", () => {
    const root = createPlatformFixture();
    const profileTarget = path.join(root, "piagent-profile.json");
    const lockTarget = path.join(root, "piagent-profile.lock.json");
    writeJson(profileTarget, { state: "original" });
    fs.symlinkSync(path.join(root, "artifact.txt"), lockTarget);
    assert.throws(() => writeProfileLockAtomic(profileTarget, { state: "updated" }, lockTarget, { state: "lock" }), /symbolic link/);
    assert.deepEqual(JSON.parse(fs.readFileSync(profileTarget, "utf8")), { state: "original" });
  });

  it("repairs a malformed existing lock during a profile update", () => {
    const root = createPlatformFixture();
    const profileTarget = path.join(root, "piagent-profile.json");
    const lockTarget = path.join(root, "piagent-profile.lock.json");
    writeJson(profileTarget, { state: "original" });
    fs.writeFileSync(lockTarget, "{malformed\n");
    writeProfileLockAtomic(profileTarget, { state: "updated" }, lockTarget, { state: "current" });
    assert.deepEqual(JSON.parse(fs.readFileSync(profileTarget, "utf8")), { state: "updated" });
    assert.deepEqual(JSON.parse(fs.readFileSync(lockTarget, "utf8")), { state: "current" });
  });

  it("reports a malformed capability policy without an internal error", () => {
    const root = createPlatformFixture();
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, "README.md"), "# Fixture\n");
    const profile = baseProfile();
    profile.capabilityPolicy.allowedLifecycles = 5;
    profile.verifyCommands = { source: 5 };
    profile.runtimePolicy = 5;
    writeJson(path.join(project, ".pi", "piagent-profile.json"), profile);
    const result = spawnSync("bash", [path.join(repositoryRoot, "scripts", "profile-doctor.sh"), project], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.errors.some((detail) => detail.includes("allowedLifecycles must be an array")), true);
    assert.equal(report.errors.some((detail) => detail.includes("verifyCommands.source must be a non-empty array")), true);
    assert.equal(report.errors.some((detail) => detail.includes("runtimePolicy must be an object")), true);
    assert.doesNotMatch(result.stderr, /TypeError|at file:/);
  });

  it("warns when shellProtectedPaths-only profile paths do not block writes", () => {
    const root = createPlatformFixture();
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    fs.writeFileSync(path.join(project, "README.md"), "# Fixture\n");
    const profile = baseProfile();
    profile.shellProtectedPaths = [".git/**", "legacy-backend/**", "review-only/**"];
    profile.readOnlyPaths = ["review-only/**"];
    writeJson(path.join(project, ".pi", "piagent-profile.json"), profile);

    const result = spawnSync("bash", [path.join(repositoryRoot, "scripts", "profile-doctor.sh"), project], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.errors.length, 0);
    assert.equal(report.shellProtectedPathCount, 3);
    assert.equal(report.readOnlyPathCount, 1);
    assert.equal(
      report.warnings.some((detail) => detail.includes("shellProtectedPaths-only path legacy-backend/**")),
      true
    );
    assert.equal(
      report.warnings.some((detail) => detail.includes("review-only/**")),
      false
    );
  });

  it("surfaces shellProtectedPaths-only warnings in team doctor", () => {
    const root = createPlatformFixture();
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    fs.writeFileSync(path.join(project, "README.md"), "# Fixture\n");
    const profile = baseProfile();
    delete profile.capabilityPacks;
    delete profile.capabilityPolicy;
    profile.shellProtectedPaths = ["legacy-backend/**"];
    writeJson(path.join(project, ".pi", "piagent-profile.json"), profile);

    const result = spawnSync("bash", [path.join(repositoryRoot, "scripts", "team-doctor.sh"), project], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.errors.length, 0);
    assert.equal(
      report.warnings.some((detail) => detail.includes("project profile shellProtectedPaths-only path legacy-backend/**")),
      true
    );
  });
});

describe("recipe and action proposal validation", () => {
  it("rejects cyclic recipe steps", () => {
    const recipe = {
      apiVersion: "piagent/v1",
      kind: "CapabilityRecipe",
      metadata: {
        name: "cyclic-recipe",
        version: "0.1.0",
        owner: "platform-maintainers",
        lifecycle: "experimental",
        license: "MIT",
        description: "Invalid cyclic recipe used for validation.",
        tags: ["test"]
      },
      spec: {
        inputs: [],
        steps: [
          { id: "first", uses: "capability:first", mode: "read-only", needs: ["second"], timeoutSeconds: 10, retries: 0, outputs: [] },
          { id: "second", uses: "capability:second", mode: "read-only", needs: ["first"], timeoutSeconds: 10, retries: 0, outputs: [] }
        ],
        gates: { context: true, verification: false, humanApproval: false }
      }
    };
    assert.throws(() => validateCapabilityRecipe(recipe), /invalid/);
  });

  it("caps recipe inputs at the schema limit", () => {
    const recipe = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packs", "engineering-base", "recipes", "bounded-change.json"), "utf8"));
    recipe.spec.inputs = Array.from({ length: 33 }, (_item, index) => ({ name: `input-${index}`, description: "Bounded input.", required: false }));
    assert.throws(
      () => validateCapabilityRecipe(recipe),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("at most 32"))
    );
  });

  it("accepts a bounded dry-run action proposal", () => {
    assert.equal(validateExternalActionProposal(validActionProposal(), { now: actionValidationNow }).spec.dryRun, true);
  });

  it("rejects action proposals that request immediate execution", () => {
    const proposal = validActionProposal();
    proposal.spec.dryRun = false;
    assert.throws(() => validateExternalActionProposal(proposal, { now: actionValidationNow }), /invalid/);
  });

  it("rejects secret-like material in an action proposal", () => {
    const proposal = validActionProposal();
    proposal.spec.summary = `Authorization: Bearer ${"a".repeat(32)}`;
    assert.throws(
      () => validateExternalActionProposal(proposal, { now: actionValidationNow }),
      (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("secret-like material"))
    );
  });

  for (const [name, secret] of [
    ["GitHub fine-grained token", ["github", "_pat_", "11AAAAAAA0abcdefghijklmnopqrstuvwxyz"].join("")],
    ["Slack token", ["xoxb", "-123456789012-123456789012-AbCdEfGhIjKlMnOp"].join("")],
    ["Google key", ["AI", "zaSyDExampleKeyWithEnoughLength123456"].join("")],
    ["OpenAI-style key", ["sk", "-abcdefghijklmnopqrstuvwxyz1234567890"].join("")]
  ]) {
    it(`rejects ${name} material`, () => {
      const proposal = validActionProposal();
      proposal.spec.summary = `Credential ${secret}`;
      assert.throws(
        () => validateExternalActionProposal(proposal, { now: actionValidationNow }),
        (error) => error instanceof CapabilityValidationError && error.errors.some((detail) => detail.includes("secret-like material"))
      );
    });
  }

  it("rejects non-canonical action timestamps", () => {
    const proposal = validActionProposal();
    proposal.metadata.createdAt = "2026-07-21";
    assert.throws(() => validateExternalActionProposal(proposal, { now: actionValidationNow }), /invalid/);
  });

  it("rejects expired action proposals", () => {
    const proposal = validActionProposal();
    assert.throws(() => validateExternalActionProposal(proposal, { now: Date.parse("2026-07-21T02:00:00.000Z") }), /invalid/);
  });

  it("rejects an invalid artifact media type", () => {
    const proposal = validActionProposal();
    proposal.spec.artifacts[0].mediaType = "abc";
    assert.throws(() => validateExternalActionProposal(proposal, { now: actionValidationNow }), /invalid/);
  });
});

describe("what a capability lock treats as consent", () => {
  it("requires a profile list when a pack activates by profile", () => {
    const manifest = baseManifest();
    manifest.spec.activation = { mode: "profile", profiles: [], triggers: [] };
    // The trigger mode has always been checked for this. Profile mode was not,
    // so resolution read `.includes` off an absent list and threw a TypeError
    // where it should have refused with a reason.
    const refusalReasons = () => {
      try {
        validateCapabilityPack(manifest);
      } catch (error) {
        assert.ok(error instanceof CapabilityValidationError);
        return JSON.stringify(error.errors);
      }
      return assert.fail("expected the pack to be refused");
    };

    assert.match(refusalReasons(), /must not be empty for profile activation/);
    delete manifest.spec.activation.profiles;
    assert.match(refusalReasons(), /must not be empty for profile activation/);
  });

  // Artifact content deliberately sits on the build side for packs the platform
  // ships: pinning those bytes would stop a policy correction from reaching the
  // projects that reference it. A vendored source is not the platform, and none
  // of that reasoning transfers to it.
  it("blocks when a vendored pack's artifact content changes", () => {
    const locked = lockDocument("team-sources", "sha256:one");
    const resolved = lockDocument("team-sources", "sha256:two");
    const verdict = classifyCapabilityLock(resolved, locked);
    assert.equal(verdict.status, "blocked");
    assert.match(verdict.reasons.join(" "), /vendored capability source changed content/);
  });

  it("re-pins rather than blocks when the platform's own artifact changes", () => {
    const locked = lockDocument("workspace", "sha256:one");
    const resolved = lockDocument("workspace", "sha256:two");
    assert.equal(classifyCapabilityLock(resolved, locked).status, "repin");
  });

  it("still reports a lock that matches as current", () => {
    const locked = lockDocument("team-sources", "sha256:one");
    assert.equal(classifyCapabilityLock(lockDocument("team-sources", "sha256:one"), locked).status, "current");
  });
});
