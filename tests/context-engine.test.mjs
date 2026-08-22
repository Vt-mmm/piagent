import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  appendContextTelemetry,
  buildContextEfficiencyReport,
  buildContextIndexV2,
  buildContextPack,
  buildTestImpact,
  classifyContextTask,
  contextEnginePaths,
  contextIndexV2Status,
  estimateContextTokens,
  ensureContextIndexV2,
  searchContextIndexV2
} from "../packages/piagent-core/extensions/context-engine.js";
import { buildSelectedContextPack } from "../packages/piagent-core/extensions/criterion-context-pack.js";
import { buildPrefixTelemetry } from "../packages/piagent-core/runtime/context/prefix-telemetry.ts";
import { injectionEfficiencyMetrics } from "../packages/piagent-core/extensions/context-efficiency-metrics.js";
import { measureContextDeltaShadow } from "../packages/piagent-core/runtime/context/context-delta-shadow.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-engine-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(cwd, "src", "math.ts"), [
    "export function calculateInvoiceTotal(values: number[]): number {",
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "service.ts"), [
    "import { calculateInvoiceTotal } from './math';",
    "",
    "export class InvoiceService {",
    "  total(values: number[]): number {",
    "    return calculateInvoiceTotal(values);",
    "  }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "tests", "math.test.ts"), [
    "import { calculateInvoiceTotal } from '../src/math';",
    "",
    "test('invoice total', () => {",
    "  expect(calculateInvoiceTotal([1, 2])).toBe(3);",
    "});",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=do-not-index\n");
  return cwd;
}

function runContextCli(cwd, args) {
  return spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "context-engine.mjs"),
    ...args,
    "--project",
    cwd,
    "--json"
  ], {
    cwd,
    encoding: "utf8"
  });
}

function writeProjectProfile(cwd, profile) {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "piagent-profile.json"),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

function contextDatabaseArtifacts(cwd) {
  const database = contextEnginePaths(cwd).database;
  return [database, `${database}-wal`, `${database}-shm`].filter((file) => fs.existsSync(file));
}

function contextDatabaseArtifactsContain(cwd, value) {
  const needle = Buffer.from(value);
  return contextDatabaseArtifacts(cwd).some((file) => fs.readFileSync(file).includes(needle));
}

function contextExcludeDigestForVersion(version, patterns) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ version, patterns }))
    .digest("hex");
}

test("classifies task signals without calling a model", () => {
  const result = classifyContextTask("Fix auth validation in src/session.ts before release");
  assert.equal(result.lane, "high-risk");
  assert.equal(result.workflow, "release");
  assert.deepEqual(result.paths, ["src/session.ts"]);
  assert.ok(result.terms.includes("validation"));
  assert.equal(result.promptHash.length, 64);
  assert.equal(classifyContextTask("Show current session token usage").workflow, "usage");
  assert.equal(classifyContextTask("Optimize token usage in src/context.ts").workflow, "task");
  assert.deepEqual(classifyContextTask("Read `.env`, then report it").paths, [".env"]);
  assert.deepEqual(
    classifyContextTask("Fix source/test boundaries and key/owner handling after crash/resume.").paths,
    []
  );
  assert.equal(classifyContextTask("Implement release current owner safely in the lease store.").workflow, "task");
  assert.equal(classifyContextTask("Run the production release now").workflow, "release");
  const vietnamese = classifyContextTask("Kiểm tra phân quyền thanh toán trong src/xác-thực.ts trước khi triển khai");
  assert.equal(vietnamese.lane, "high-risk");
  assert.equal(vietnamese.workflow, "release");
  assert.deepEqual(vietnamese.paths, ["src/xác-thực.ts"]);
  assert.ok(vietnamese.terms.includes("phân"));
  assert.ok(estimateContextTokens("phân quyền bảo mật") > estimateContextTokens("plain ascii text"));
});

test("retrieves Vietnamese source signals with accented or unaccented queries", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "phan-quyen.ts"), [
    "// Kiểm tra phân quyền thanh toán trước khi phát hành.",
    "// Đăng nhập an toàn cho người dùng nội bộ.",
    "export function kiemTraQuyenThanhToan() { return true; }",
    ""
  ].join("\n"));
  await buildContextIndexV2(cwd, { excludePatterns: [] });
  const accented = await searchContextIndexV2(cwd, "phân quyền thanh toán", { excludePatterns: [] });
  const unaccented = await searchContextIndexV2(cwd, "phan quyen thanh toan", { excludePatterns: [] });
  const crossedD = await searchContextIndexV2(cwd, "dang nhap an toan", { excludePatterns: [] });
  assert.equal(accented.results[0]?.path, "src/phan-quyen.ts");
  assert.equal(unaccented.results[0]?.path, "src/phan-quyen.ts");
  assert.equal(crossedD.results[0]?.path, "src/phan-quyen.ts");
});

test("fails closed when a content API omits its exclusion policy", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const operations = [
    ["buildContextIndexV2", () => buildContextIndexV2(cwd)],
    ["contextIndexV2Status", () => contextIndexV2Status(cwd)],
    ["ensureContextIndexV2", () => ensureContextIndexV2(cwd)],
    ["searchContextIndexV2", () => searchContextIndexV2(cwd, "invoice")],
    ["buildContextPack", () => buildContextPack(cwd, "invoice")],
    ["buildSelectedContextPack", async () => buildSelectedContextPack(cwd, [{ path: "src/math.ts" }])],
    ["buildTestImpact", () => buildTestImpact(cwd, ["src/math.ts"])]
  ];

  for (const [name, operation] of operations) {
    await assert.rejects(operation, new RegExp(`${name} requires an explicit excludePatterns array`));
  }
});

test("builds an incremental local index and retrieves symbols with hybrid evidence", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });

  const first = await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(first.files, 4);
  assert.ok(first.symbols >= 2);
  assert.equal(first.changed, 4);
  assert.equal(fs.existsSync(contextEnginePaths(cwd).database), true);

  const second = await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(second.changed, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.reused, 4);

  const search = await searchContextIndexV2(cwd, "calculateInvoiceTotal implementation", {
    limit: 5,
    excludePatterns: []
  });
  assert.equal(search.results[0].path, "src/math.ts");
  assert.ok(search.results[0].sources.includes("symbol"));
  assert.ok(["high", "medium"].includes(search.confidence));
  assert.equal(search.results.some((result) => result.path === ".env"), false);

  const status = await contextIndexV2Status(cwd, { excludePatterns: [] });
  assert.equal(status.exists, true);
  assert.equal(status.files, 4);
  assert.equal(status.stale, false);

  fs.appendFileSync(path.join(cwd, "src", "math.ts"), "// changed\n");
  const stale = await contextIndexV2Status(cwd, { excludePatterns: [] });
  assert.equal(stale.stale, true);
  assert.ok(stale.stalePaths.includes("src/math.ts"));

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  fs.writeFileSync(path.join(cwd, "src", "new-module.ts"), "export const newModule = true;\n");
  const added = await contextIndexV2Status(cwd, { excludePatterns: [] });
  assert.equal(added.stale, true);
  assert.ok(added.stalePaths.includes("src/new-module.ts"));
});

test("packs ranked snippets to a hard token budget and reports low-confidence finder fallback", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "calculateInvoiceTotal invoice total calculation calculateInvoiceTotal\n");
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const pack = await buildContextPack(cwd, "invoice total calculation", {
    budgetTokens: 500,
    excludePatterns: []
  });
  assert.ok(pack.estimatedTokens <= 500);
  assert.match(pack.text, /Repository map:/);
  assert.match(pack.text, /src\/math\.ts/);

  const unfiltered = await searchContextIndexV2(cwd, "invoice total calculation", {
    limit: 12,
    excludePatterns: []
  });
  assert.ok(unfiltered.results.some((result) => result.path === "AGENTS.md"));

  const snapshot = await buildContextPack(cwd, "invoice total calculation", {
    budgetTokens: 700,
    includePatterns: ["src/**", "tests/**"],
    currentSnapshot: true,
    excludePatterns: []
  });
  assert.ok(snapshot.estimatedTokens <= 700);
  assert.match(snapshot.text, /Current-turn source snapshot/);
  assert.match(snapshot.text, /calculateInvoiceTotal/);
  assert.doesNotMatch(snapshot.text, /package\.json|AGENTS\.md/);

  const missing = await buildContextPack(cwd, "quantum zebra subsystem", {
    budgetTokens: 400,
    excludePatterns: []
  });
  assert.equal(missing.finderRecommended, true);
  assert.match(missing.finderRequest, /bounded read-only finder pass/);
});

test("packs exact graph-selected files without an index, secrets, symlinks, or partial oversized content", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.symlinkSync(path.join(cwd, "src", "math.ts"), path.join(cwd, "src", "linked.ts"));
  const pack = buildSelectedContextPack(cwd, [
    { path: "src/math.ts" }, { path: "src/service.ts" }, { path: ".env" }, { path: "src/linked.ts" }
  ], { budgetTokens: 900, excludePatterns: ["src/service.ts"] });
  assert.deepEqual(pack.selected.map((entry) => entry.path), ["src/math.ts"]);
  assert.equal(pack.selected[0].contentDigest, crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, "src", "math.ts"))).digest("hex"));
  assert.ok(pack.estimatedTokens <= 900);
  assert.match(pack.text, /criterion context snapshot/);
  assert.match(pack.text, /calculateInvoiceTotal/);
  assert.doesNotMatch(pack.text, /SECRET=|linked\.ts|service\.ts/);
  assert.deepEqual(buildSelectedContextPack(cwd, [{ path: "src/math.ts" }], {
    budgetTokens: 900, maxFileBytes: 16, excludePatterns: []
  }), { text: "", selected: [], estimatedTokens: 0 });
});

test("keeps context index storage private to the current OS account", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  const paths = contextEnginePaths(cwd);

  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.database).mode & 0o777, 0o600);

  fs.chmodSync(paths.root, 0o755);
  fs.chmodSync(paths.database, 0o644);
  await contextIndexV2Status(cwd, { excludePatterns: [] });

  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.database).mode & 0o777, 0o600);
});

test("purges raw indexed bytes when the exclusion policy tightens", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const DB_URL = 'postgres://user:HUNTER2@prod/db';\n"
  );

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(contextDatabaseArtifactsContain(cwd, "HUNTER2"), true);

  const ensured = await ensureContextIndexV2(cwd, {
    excludePatterns: ["backend/**"],
    rebuildMissing: true
  });
  const search = await searchContextIndexV2(cwd, "HUNTER2", {
    excludePatterns: ["backend/**"]
  });

  assert.equal(ensured.rebuilt, true);
  assert.equal(ensured.reason, "exclusion-policy");
  assert.equal(ensured.build.purgedStaleContent, true);
  assert.equal(search.results.some((result) => result.path === "backend/credentials.ts"), false);
  assert.equal(contextDatabaseArtifactsContain(cwd, "HUNTER2"), false);
  assert.equal(fs.statSync(contextEnginePaths(cwd).database).mode & 0o777, 0o600);
});

test("securely deletes raw bytes during an ordinary same-policy rebuild", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const secret = "samepolicysecuredeletehunter2token";
  const target = path.join(cwd, "src", "temporary-secret.ts");
  fs.writeFileSync(target, `export const value = ${JSON.stringify(`${secret}\n`.repeat(256))};\n`);

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  assert.equal(contextDatabaseArtifactsContain(cwd, secret), true);

  fs.unlinkSync(target);
  const rebuilt = await buildContextIndexV2(cwd, { excludePatterns: [] });

  assert.equal(rebuilt.purgedStaleContent, false);
  assert.equal(contextDatabaseArtifactsContain(cwd, secret), false);
});

test("commits purgePending before expensive policy migration and resumes after interruption", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const PRODUCER_MARKER = 'must-be-purged';\n"
  );
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  let observedMetadata;
  let purgeStarts = 0;
  await assert.rejects(
    () => buildContextIndexV2(cwd, {
      excludePatterns: ["backend/**"],
      onPurgeStart: async () => {
        purgeStarts += 1;
        const { DatabaseSync } = await import("node:sqlite");
        const reader = new DatabaseSync(contextEnginePaths(cwd).database, { readOnly: true });
        try {
          observedMetadata = Object.fromEntries(
            reader.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value])
          );
        } finally {
          reader.close();
        }
        throw new Error("simulated interruption after purge marker commit");
      }
    }),
    /simulated interruption after purge marker commit/
  );

  assert.equal(purgeStarts, 1);
  assert.equal(observedMetadata.purgePending, "1");
  const interrupted = await contextIndexV2Status(cwd, { excludePatterns: ["backend/**"] });
  assert.equal(observedMetadata.excludeDigest, interrupted.expectedExcludeDigest);
  assert.equal(interrupted.policyStale, true);
  assert.equal(interrupted.purgePending, true);

  const resumed = await ensureContextIndexV2(cwd, {
    excludePatterns: ["backend/**"],
    rebuildMissing: true
  });

  assert.equal(resumed.rebuilt, true);
  assert.equal(resumed.reason, "exclusion-policy");
  assert.equal(resumed.build.purgedStaleContent, true);
  assert.equal(resumed.status.purgePending, false);
});

test("vacuum purges raw bytes left by a legacy exclusion policy", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const secret = "legacypolicyresiduehunter2token";
  const legacyPath = "legacy/deleted-secret.ts";
  const legacyBody = `export const legacy = ${JSON.stringify(`${secret}\n`.repeat(256))};\n`;
  const legacyExcludeDigest = contextExcludeDigestForVersion(1, []);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(contextEnginePaths(cwd).database);
  try {
    db.exec(`
      PRAGMA secure_delete = OFF;
      INSERT INTO file_fts(file_fts, rank) VALUES('secure-delete', 0);
      BEGIN IMMEDIATE;
    `);
    db.prepare(`
      INSERT INTO files(path, hash, bytes, mtime_ms, language, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(legacyPath, "legacy-hash", Buffer.byteLength(legacyBody), Date.now(), "typescript", new Date().toISOString());
    db.prepare("INSERT INTO file_fts(path, body, symbol_names) VALUES (?, ?, ?)").run(
      legacyPath,
      legacyBody,
      "legacy"
    );
    db.prepare("DELETE FROM file_fts WHERE path = ?").run(legacyPath);
    db.prepare("DELETE FROM files WHERE path = ?").run(legacyPath);
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'excludeDigest'").run(legacyExcludeDigest);
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'excludePolicyVersion'").run("1");
    db.exec(`
      COMMIT;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally {
    db.close();
  }

  assert.equal(contextDatabaseArtifactsContain(cwd, secret), true);
  const before = await contextIndexV2Status(cwd, { excludePatterns: [] });
  assert.equal(before.policyStale, true);
  assert.equal(before.purgePending, false);
  assert.equal(contextDatabaseArtifactsContain(cwd, secret), true);

  const ensured = await ensureContextIndexV2(cwd, {
    excludePatterns: [],
    rebuildMissing: true
  });

  assert.equal(ensured.rebuilt, true);
  assert.equal(ensured.reason, "exclusion-policy");
  assert.equal(ensured.build.purgedStaleContent, true);
  assert.equal(ensured.status.purgePending, false);
  assert.equal(contextDatabaseArtifactsContain(cwd, secret), false);
});

test("keeps configured protected paths out of both the index and stale signal", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "private.ts"), "export const privateValue = 'secret';\n");

  await buildContextIndexV2(cwd, { excludePatterns: ["src/private.ts"] });
  const status = await contextIndexV2Status(cwd, {
    excludePatterns: ["src/private.ts"]
  });
  const search = await searchContextIndexV2(cwd, "privateValue", {
    excludePatterns: ["src/private.ts"]
  });
  assert.equal(status.stale, false);
  assert.equal(search.results.some((result) => result.path === "src/private.ts"), false);
});

test("CLI rebuild excludes readOnlyPaths from search and packs", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const DB_URL = 'postgres://user:HUNTER2@prod/db';\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    projectId: "readonly-fixture",
    displayName: "Readonly Fixture",
    mode: "custom",
    protectedPaths: [],
    readOnlyPaths: ["backend/**"]
  });

  const rebuild = runContextCli(cwd, ["rebuild"]);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  const search = runContextCli(cwd, ["search", "HUNTER2"]);
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).results.some((result) => result.path === "backend/credentials.ts"), false);
  const allowedSearch = runContextCli(cwd, ["search", "calculateInvoiceTotal"]);
  assert.equal(allowedSearch.status, 0, allowedSearch.stderr);
  assert.equal(JSON.parse(allowedSearch.stdout).results.some((result) => result.path === "src/math.ts"), true);
  const pack = runContextCli(cwd, ["pack", "HUNTER2 production database"]);
  assert.equal(pack.status, 0, pack.stderr);
  assert.doesNotMatch(JSON.parse(pack.stdout).text, /HUNTER2|backend\/credentials\.ts/);
});

test("CLI resolves adapter extends before building context exclusions", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "data", "production"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "data", "production", "dump.sql"),
    "select 'ADAPTER_PROTECTED_VALUE' as production_secret;\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    extends: "data",
    projectId: "data-fixture",
    displayName: "Data Fixture"
  });

  const rebuild = runContextCli(cwd, ["rebuild"]);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  const search = runContextCli(cwd, ["search", "ADAPTER_PROTECTED_VALUE"]);
  assert.equal(search.status, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).results.some((result) => result.path === "data/production/dump.sql"), false);
});

test("CLI pack rebuilds an existing index when its exclusion policy differs", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "backend"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "backend", "credentials.ts"),
    "export const LEGACY_INDEX_SECRET = 'STALE_POLICY_VALUE';\n"
  );
  writeProjectProfile(cwd, {
    schemaVersion: 1,
    projectId: "stale-policy-fixture",
    displayName: "Stale Policy Fixture",
    mode: "custom",
    protectedPaths: [],
    readOnlyPaths: ["backend/**"]
  });
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const before = runContextCli(cwd, ["status"]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).policyStale, true);

  const pack = runContextCli(cwd, ["pack", "STALE_POLICY_VALUE"]);
  assert.equal(pack.status, 0, pack.stderr);
  const parsed = JSON.parse(pack.stdout);
  assert.doesNotMatch(parsed.text, /STALE_POLICY_VALUE|backend\/credentials\.ts/);
  assert.equal(parsed.status.policyStale, false);
});

test("does not index or pack a source-shaped symlink outside the project", async (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-outside-"));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const externalFile = path.join(outside, "external.ts");
  fs.writeFileSync(externalFile, "export const OUTSIDE_PROJECT_VALUE = 'must-not-enter-context';\n");
  try {
    fs.symlinkSync(externalFile, path.join(cwd, "src", "outside.ts"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlinks are unavailable on this platform");
      return;
    }
    throw error;
  }
  execFileSync("git", ["init", "-q"], { cwd });

  await buildContextIndexV2(cwd, { excludePatterns: [] });
  const search = await searchContextIndexV2(cwd, "OUTSIDE_PROJECT_VALUE", { excludePatterns: [] });
  const pack = await buildContextPack(cwd, "OUTSIDE_PROJECT_VALUE", {
    budgetTokens: 500,
    excludePatterns: []
  });

  assert.equal(search.results.some((result) => result.path === "src/outside.ts"), false);
  assert.doesNotMatch(pack.text, /OUTSIDE_PROJECT_VALUE|must-not-enter-context|src\/outside\.ts/);
});

test("does not search or pack a stale index entry after its file becomes a symlink", async (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-context-outside-"));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const indexedPath = path.join(cwd, "src", "linked.ts");
  const externalFile = path.join(outside, "external.ts");
  fs.writeFileSync(indexedPath, "export const LEGACY_SYMLINK_VALUE = 'local-before-link';\n");
  fs.writeFileSync(externalFile, "export const LEGACY_SYMLINK_VALUE = 'outside-after-link';\n");
  await buildContextIndexV2(cwd, { excludePatterns: [] });
  fs.unlinkSync(indexedPath);
  try {
    fs.symlinkSync(externalFile, indexedPath);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlinks are unavailable on this platform");
      return;
    }
    throw error;
  }

  const status = await contextIndexV2Status(cwd, { excludePatterns: [] });
  const search = await searchContextIndexV2(cwd, "LEGACY_SYMLINK_VALUE", { excludePatterns: [] });
  const pack = await buildContextPack(cwd, "LEGACY_SYMLINK_VALUE", {
    budgetTokens: 500,
    excludePatterns: []
  });

  assert.equal(status.stale, true);
  assert.equal(search.results.some((result) => result.path === "src/linked.ts"), false);
  assert.doesNotMatch(pack.text, /LEGACY_SYMLINK_VALUE|outside-after-link|src\/linked\.ts/);
});

test("does not make intentionally skipped large or binary sources permanently stale", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "generated.ts"), "x".repeat(2_048));
  fs.writeFileSync(path.join(cwd, "src", "binary.ts"), Buffer.from([0, 1, 2, 3]));

  const build = await buildContextIndexV2(cwd, { maxFileBytes: 1_024, excludePatterns: [] });
  const status = await contextIndexV2Status(cwd, { excludePatterns: [] });
  assert.equal(build.skippedLarge, 1);
  assert.equal(build.skippedBinary, 1);
  assert.equal(status.stale, false);
});

test("maps reverse imports and related tests for targeted verification", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const impact = await buildTestImpact(cwd, ["src/math.ts"], { excludePatterns: [] });
  assert.ok(impact.impactedFiles.some((file) => file.path === "src/service.ts"));
  assert.ok(impact.tests.includes("tests/math.test.ts"));
});

test("writes Agent Watch compatible telemetry and transparent context waste metrics", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  appendContextTelemetry(cwd, {
    event: "agent_prompt",
    sessionId: "session-1",
    turnId: "turn-1",
    activeTools: 30,
    systemPromptTokens: 10_000,
    toolSchemaTokens: 2_000,
    prefixSurfaceHash: "prefix-a"
  });
  appendContextTelemetry(cwd, { event: "turn_task_bound", sessionId: "session-1", turnId: "turn-1", taskRunId: "run-1" });
  appendContextTelemetry(cwd, { event: "agent_prompt", sessionId: "session-1", taskRunId: "run-1", activeTools: 30, systemPromptTokens: 10_000, toolSchemaTokens: 2_000, prefixSurfaceHash: "prefix-a" });
  appendContextTelemetry(cwd, { event: "agent_prompt", sessionId: "session-1", taskRunId: "run-1", activeTools: 30, systemPromptTokens: 10_000, toolSchemaTokens: 2_000, prefixSurfaceHash: "prefix-b" });
  appendContextTelemetry(cwd, { event: "tool_call", toolName: "read", inputHash: "same", targetHash: "same" });
  appendContextTelemetry(cwd, { event: "tool_call", toolName: "read", inputHash: "same", targetHash: "same" });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 1_000, repeated: false });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 1_000, repeated: true });
  appendContextTelemetry(cwd, {
    event: "context_pack",
    sessionId: "session-1",
    confidence: "low",
    selectedPaths: ["src/math.ts", "src/service.ts"]
  });
  const injection = { event: "context_pack_injected", sessionId: "session-1", taskRunId: "run-1", source: "auto-pack", selectedPaths: ["src/math.ts"], selectedItems: [{ path: "src/math.ts", estimatedTokens: 50, fileContentHash: "file-1", payloadHash: "payload-1", representation: "snippet", ranges: [{ start: 1, end: 3 }], generation: 1 }] };
  appendContextTelemetry(cwd, injection);
  appendContextTelemetry(cwd, injection);
  appendContextTelemetry(cwd, {
    event: "tool_call",
    sessionId: "session-1",
    taskRunId: "run-1",
    toolName: "read",
    targetPath: "src/math.ts",
    inputHash: "math-read"
  });

  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.source, "piagent");
  assert.equal(report.sample.contextPacks, 1);
  assert.equal(report.sample.contextPacksInjected, 2);
  assert.equal(report.metrics.duplicateReads, 1);
  assert.equal(report.metrics.duplicateOutputChars, 1_000);
  assert.equal(report.metrics.contextSelections, 2);
  assert.equal(report.metrics.contextSelectionsUsed, 1);
  assert.equal(report.metrics.contextUtilizationRate, 0.5);
  assert.equal(report.metrics.prefixChangeRate, 0.5);
  assert.equal(report.metrics.averageTurnsPerPrefixEpoch, 1.5);
  assert.equal(report.metrics.duplicateInjectionRate, 0.5);
  assert.equal(report.metrics.duplicateInjectionTokenRate, 0.5);
  assert.ok(report.metrics.contextWasteScore > 0);
  assert.match(report.methodology.note, /not a quality verdict/);
  assert.match(report.methodology.retrievalFeedback, /Positive-only/);
  assert.equal(fs.existsSync(contextEnginePaths(cwd).report), true);
});

test("uses only evidenced positive feedback as a weak retrieval signal", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  appendContextTelemetry(cwd, {
    event: "context_pack_injected",
    sessionId: "session-feedback",
    taskRunId: "feedback-run",
    selectedPaths: ["src/math.ts", "src/service.ts"],
    selectedItems: [{ path: "src/math.ts", estimatedTokens: 20 }, { path: "src/service.ts", estimatedTokens: 20 }]
  });
  appendContextTelemetry(cwd, {
    event: "tool_call",
    sessionId: "session-feedback",
    taskRunId: "feedback-run",
    toolName: "read",
    targetPath: "src/math.ts"
  });

  const search = await searchContextIndexV2(cwd, "invoice total", {
    limit: 5,
    excludePatterns: []
  });
  const used = search.results.find((result) => result.path === "src/math.ts");
  const unused = search.results.find((result) => result.path === "src/service.ts");
  assert.ok(used?.sources.includes("feedback"));
  assert.equal(unused?.sources.includes("feedback") ?? false, false);
});

test("canonical prefix hashes ignore tool and nested schema key ordering", () => {
  const leftTools = [
    { name: "zeta", description: "Z", parameters: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } } },
    { name: "alpha", description: "A", parameters: { required: ["value"], type: "object" } }
  ];
  const rightTools = [
    { parameters: { type: "object", required: ["value"] }, description: "A", name: "alpha" },
    { parameters: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" }, name: "zeta", description: "Z" }
  ];
  const left = buildPrefixTelemetry("system", leftTools);
  const right = buildPrefixTelemetry("system", rightTools);
  assert.equal(left.toolSchemaHash, right.toolSchemaHash);
  assert.equal(left.prefixSurfaceHash, right.prefixSurfaceHash);
  assert.notEqual(buildPrefixTelemetry("changed", rightTools).prefixSurfaceHash, right.prefixSurfaceHash);
});

test("duplicate injection metrics stay task/session-bound and fail safe on incomplete receipts", () => {
  const item = { path: "src/math.ts", estimatedTokens: 30, fileContentHash: "file-1", payloadHash: "payload-1", representation: "snippet", ranges: [{ start: 1, end: 3 }], generation: 1 };
  const metrics = injectionEfficiencyMetrics([
    { event: "context_pack", sessionId: "session-a", taskRunId: "run-a", selectedItems: [item] },
    { event: "context_pack_injected", sessionId: "session-a", taskRunId: "run-a", selectedItems: [item] },
    { event: "context_pack_injected", sessionId: "session-a", taskRunId: "run-a", selectedItems: [item] },
    { event: "context_pack_injected", sessionId: "session-b", taskRunId: "run-b", selectedItems: [item] },
    { event: "context_pack_injected", sessionId: "session-a", taskRunId: "run-a", selectedItems: [{ path: "src/incomplete.ts", estimatedTokens: 10 }] },
    { event: "context_pack_injected", sessionId: "session-a", taskRunId: "run-a", source: "compaction-rehydrate", selectedItems: [item] }
  ]);
  assert.equal(metrics.injectedPathOccurrences, 5);
  assert.equal(metrics.comparableInjectionItems, 3);
  assert.equal(metrics.duplicateInjections, 1);
  assert.equal(Number(metrics.duplicateInjectionRate.toFixed(4)), 0.2);
  assert.equal(Number(metrics.duplicateInjectionTokenRate.toFixed(4)), 0.2308);
  assert.deepEqual(injectionEfficiencyMetrics([]), {
    injectedPathOccurrences: 0, comparableInjectionItems: 0, duplicateInjections: 0,
    duplicateInjectionRate: 0, macroDuplicateInjectionRate: 0, injectedPathTokens: 0,
    duplicateInjectionTokens: 0, duplicateInjectionTokenRate: 0
  });
});

test("delta shadow measures manifested candidates without injecting or running under pressure", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  await buildContextIndexV2(cwd, { excludePatterns: [] });
  const events = [];
  const task = { taskRunId: "shadow-run", contextManifest: [{ path: "src/math.ts", reason: "Runtime observed successful source read." }] };
  const ctx = { cwd, getContextUsage: () => ({ percent: 20 }) };
  await measureContextDeltaShadow({ ctx, query: "invoice total math service", turnId: "shadow-turn", task, mode: "on", protectedTarget: false, excludePatterns: [], telemetry: (_ctx, event) => events.push(event) });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "context_delta_shadow");
  assert.ok(events[0].candidatePaths.includes("src/math.ts"));
  assert.ok(events[0].pathsAlreadyManifested.includes("src/math.ts"));
  assert.ok(events[0].duplicateCandidateTokens > 0);
  assert.deepEqual(task.contextManifest, [{ path: "src/math.ts", reason: "Runtime observed successful source read." }]);
  await measureContextDeltaShadow({ ctx: { ...ctx, getContextUsage: () => ({ percent: 90 }) }, query: "invoice total math service", turnId: "pressure-turn", task, mode: "on", protectedTarget: false, excludePatterns: [], telemetry: (_ctx, event) => events.push(event) });
  assert.equal(events.length, 1, "high context pressure skips shadow selection");
  await measureContextDeltaShadow({ ctx, query: "inspect .env secret", turnId: "protected-turn", task, mode: "on", protectedTarget: true, excludePatterns: ["**/.env"], telemetry: (_ctx, event) => events.push(event) });
  assert.equal(events.length, 1, "protected targets never enter shadow telemetry");
});
