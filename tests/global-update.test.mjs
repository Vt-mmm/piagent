// A platform update is global: one install moves, and no project is touched.
// These tests run a project across two platform builds to check what that
// actually does to it — what flows through, what stops it, and what stays the
// project's own decision.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { callToolCall, createContext, createPiHarness, writeRuntimeStubs } from "./helpers/guard-harness.mjs";
import { resolveCapabilityProfile, writeJsonAtomic } from "../packages/piagent-core/capabilities/capability-core.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();
// Synthetic build numbers: these stand for "the version a project onboarded
// against" and "the version the team updated to", not for any real release.
const BEFORE = "0.0.1";
const AFTER = "0.0.2";
const packageSource = "npm:@piagent/platform@0.0.1";
let installCount = 0;

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-global-update-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// An install is the whole tree the guard resolves against: its version, its
// adapters, its packs, and its runtime files. Copying it per version is what
// makes "the team ran the update" testable without touching a project.
async function installPlatform(version, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-global-update-platform-"));
  temporaryRoots.add(root);
  writeRuntimeStubs(root);
  for (const directory of ["packages", "adapters", "packs", "evals"]) {
    fs.cpSync(path.join(repoRoot, directory), path.join(root, directory), { recursive: true });
  }
  const packageDocument = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  packageDocument.version = version;
  writeJson(path.join(root, "package.json"), packageDocument);
  mutate?.(root);
  installCount += 1;
  const moduleUrl = pathToFileURL(path.join(root, "packages", "piagent-core", "extensions", "piagent-guard.ts")).href;
  const imported = await import(`${moduleUrl}?install=${installCount}`);
  return { root, piagentGuard: imported.default };
}

function adapterProfile(root, name) {
  return path.join(root, "adapters", name, "profile.json");
}

function editJson(file, edit) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(document);
  writeJson(file, document);
}

// A project stores its identity and whatever it overrides. Its policy is a
// reference to an adapter in whichever platform is installed.
function createProject(adapter, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-global-update-project-"));
  temporaryRoots.add(root);
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Global Update Fixture\n");
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
  writeJson(path.join(cwd, ".pi", "settings.json"), { packages: [packageSource] });
  writeJson(path.join(cwd, ".pi", "piagent-profile.json"), {
    schemaVersion: 1,
    extends: adapter,
    projectId: "global-update-project",
    displayName: "Global Update Project",
    ...overrides
  });
  return cwd;
}

// Onboarding is the one per-project step. It pins the lock to whatever platform
// is installed at that moment, which is what every later update moves away from.
function onboard(platformRoot, cwd) {
  const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
  const lock = resolveCapabilityProfile(platformRoot, profilePath, { packageSource });
  writeJsonAtomic(path.join(cwd, ".pi", "piagent-profile.lock.json"), lock);
  return lock;
}

function readLock(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "piagent-profile.lock.json"), "utf8"));
}

async function startSession(piagentGuard, cwd, options = {}) {
  const ctx = createContext(cwd, options);
  const harness = createPiHarness();
  piagentGuard(harness.pi);
  await harness.handlers.get("session_start")({}, ctx);
  return { ctx, harness, notices: ctx.ui.notices, toolCall: harness.handlers.get("tool_call") };
}

function noticeMatching(notices, pattern) {
  return notices.find((notice) => pattern.test(notice.message));
}

describe("global platform update", () => {
  it("keeps a project working after a release it never opted into", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    // A real release moves the version and the runtime files together.
    const after = await installPlatform(AFTER, (root) => {
      fs.appendFileSync(path.join(root, "packages", "piagent-core", "extensions", "policy-core.js"), "\n// release change\n");
    });
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.notEqual(write.block, true);
    assert.equal(readLock(cwd).core.packageVersion, AFTER);
    assert.equal(noticeMatching(session.notices, /Capability lock re-pinned/).message.includes(AFTER), true);
    assert.equal(noticeMatching(session.notices, /Reapply the project profile/), undefined);
  });

  it("reports the re-pin instead of moving the project's grant", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    const original = onboard(before.root, cwd);

    const after = await installPlatform(AFTER);
    const session = await startSession(after.piagentGuard, cwd);
    const repinned = readLock(cwd);

    assert.deepEqual(repinned.permissions, original.permissions);
    assert.deepEqual(repinned.packs, original.packs);
    assert.deepEqual(repinned.profile, original.profile);
    assert.notEqual(repinned.core.packageDigest, original.core.packageDigest);
    assert.match(noticeMatching(session.notices, /Capability lock re-pinned/).message, /capabilities this project grants are unchanged/);
  });

  it("carries a tightened adapter into a project whose files never changed", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    onboard(before.root, cwd);
    const profilePath = path.join(cwd, ".pi", "piagent-profile.json");
    const storedBefore = fs.readFileSync(profilePath, "utf8");

    const after = await installPlatform(AFTER, (root) => {
      editJson(adapterProfile(root, "generic"), (profile) => {
        profile.protectedPaths.push("infra/secrets/**");
      });
    });
    const session = await startSession(after.piagentGuard, cwd);
    const blocked = await callToolCall(session.toolCall, session.ctx, "write", { path: "infra/secrets/keys.json", content: "{}\n" });
    const allowed = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.equal(blocked.block, true);
    assert.notEqual(allowed.block, true);
    assert.equal(fs.readFileSync(profilePath, "utf8"), storedBefore);
  });

  it("stops a project when an update drops a protection it agreed to", async () => {
    const addProtection = (root) => {
      editJson(adapterProfile(root, "generic"), (profile) => {
        profile.protectedPaths.push("infra/secrets/**");
      });
    };
    const before = await installPlatform(BEFORE, addProtection);
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER);
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.equal(write.block, true);
    assert.match(write.reason, /does not match what this project agreed to/);
    assert.match(write.reason, /protectedPaths would stop covering infra\/secrets\/\*\*/);
    assert.equal(readLock(cwd).core.packageVersion, BEFORE);
  });

  // Prompts, skills, and subagents ship as pack artifacts, so a release that
  // corrects one has to reach the projects already using it.
  it("carries a corrected prompt into a project that never reapplied", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER, (root) => {
      fs.appendFileSync(path.join(root, "packages", "piagent-core", "prompts", "task.md"), "\nAlways state what you did not verify.\n");
    });
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.notEqual(write.block, true);
    assert.equal(readLock(cwd).core.packageVersion, AFTER);
  });

  // Content moving is a build change, but the set of artifacts a pack provides
  // is declared in its manifest, and that stays consent.
  it("stops a project when a pack starts providing an artifact it never agreed to", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER, (root) => {
      fs.writeFileSync(path.join(root, "packages", "piagent-core", "prompts", "exfiltrate.md"), "# Added prompt\n");
      editJson(path.join(root, "packs", "engineering-base", "pack.json"), (manifest) => {
        manifest.spec.provides.prompts.push({ id: "exfiltrate", path: "packages/piagent-core/prompts/exfiltrate.md" });
      });
    });
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.equal(write.block, true);
    assert.match(write.reason, /packs no longer matches the locked value/);
    assert.equal(readLock(cwd).core.packageVersion, BEFORE);
  });

  it("stops a project when an update widens what a pack may write", async () => {
    const packManifest = (root) => path.join(root, "packs", "engineering-base", "pack.json");
    const before = await installPlatform(BEFORE, (root) => {
      editJson(packManifest(root), (manifest) => {
        manifest.spec.permissions.filesystemWrite = [];
      });
    });
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER);
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.equal(write.block, true);
    assert.match(write.reason, /filesystemWrite would grant \*\*\/\*/);
    assert.equal(readLock(cwd).core.packageVersion, BEFORE);
  });

  it("keeps a project override stronger than the adapter it extends", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic", { permissionProfile: "read-only" });
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER, (root) => {
      editJson(adapterProfile(root, "generic"), (profile) => {
        profile.permissionProfile = "trusted-full-access";
      });
    });
    const session = await startSession(after.piagentGuard, cwd);

    assert.match(session.notices[0].message, /permission=read-only/);
  });

  it("refuses to run when the adapter a project names is gone", async () => {
    const before = await installPlatform(BEFORE);
    const cwd = createProject("generic");
    onboard(before.root, cwd);

    const after = await installPlatform(AFTER, (root) => {
      fs.rmSync(path.join(root, "adapters", "generic"), { recursive: true, force: true });
    });
    const session = await startSession(after.piagentGuard, cwd);
    const write = await callToolCall(session.toolCall, session.ctx, "write", { path: "src/index.ts", content: "export const value = 2;\n" });

    assert.equal(write.block, true);
    assert.match(write.reason, /not an adapter in the installed platform/);
  });
});
