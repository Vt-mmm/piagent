import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
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
  searchContextIndexV2,
  toolResultFingerprint
} from "../packages/piagent-core/extensions/context-engine.js";
import {
  buildSelectedContextPack,
  composeCriterionContextEntries
} from "../packages/piagent-core/extensions/criterion-context-pack.js";
import { extractJavaScriptModuleImports } from "../packages/piagent-core/extensions/context-import-links.js";
import { buildPrefixTelemetry } from "../packages/piagent-core/runtime/context/prefix-telemetry.ts";
import { injectionEfficiencyMetrics, readEfficiencyMetrics } from "../packages/piagent-core/extensions/context-efficiency-metrics.js";
import { measureContextDeltaShadow } from "../packages/piagent-core/runtime/context/context-delta-shadow.ts";
import { redactSensitiveProjectFileText } from "../packages/piagent-core/security/sensitive-data.js";

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

test("retains explicit safe project globs without accepting traversal or surrounding prose", () => {
  const result = classifyContextTask([
    "Exact writable globs: `v-nexus-frontend/src/**`, v-nexus-frontend/e2e/**.",
    "Also inspect src/**/*.{ts,tsx}; ignore ../secrets/** and v-nexus-frontend/src/../../backend/**.",
    "The URL https://example.com/docs/** is documentation, not a project path."
  ].join(" "));

  assert.deepEqual(result.paths, [
    "v-nexus-frontend/src/**",
    "v-nexus-frontend/e2e/**",
    "src/**/*.{ts,tsx}"
  ]);
  assert.equal(result.paths.some((candidate) => candidate.includes("..")), false);
  assert.equal(result.paths.some((candidate) => candidate.startsWith("http")), false);
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

  const explicitSearch = await searchContextIndexV2(cwd, "Inspect src/math.ts", {
    limit: 8,
    excludePatterns: []
  });
  const directImporter = explicitSearch.results.find((result) => result.path === "src/service.ts");
  assert.ok(directImporter?.sources.includes("import"));
  assert.deepEqual(directImporter?.links, [{ kind: "candidate-imports-explicit", path: "src/math.ts" }]);
  const directTest = explicitSearch.results.find((result) => result.path === "tests/math.test.ts");
  assert.ok(directTest?.sources.includes("import"));
  assert.deepEqual(directTest?.links, [{ kind: "candidate-imports-explicit", path: "src/math.ts" }]);
  const composed = composeCriterionContextEntries({
    explicitPaths: ["src/math.ts"],
    criteria: ["Preserve calculateInvoiceTotal and its focused behavior."],
    plannedEntries: [{ path: "src/math.ts", reason: "criterion source" }],
    plannedSelectionComplete: false,
    retrievedItems: explicitSearch.results
  }, { limit: 2 });
  assert.deepEqual(composed.map((entry) => entry.path), ["src/math.ts", "tests/math.test.ts"]);

  const importerSearch = await searchContextIndexV2(cwd, "Inspect src/service.ts", { limit: 8, excludePatterns: [] });
  const directDependency = importerSearch.results.find((result) => result.path === "src/math.ts");
  assert.deepEqual(directDependency?.links, [{ kind: "explicit-imports-candidate", path: "src/service.ts" }]);

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
  const mathItem = pack.selected.find((entry) => entry.path === "src/math.ts");
  const mathDigest = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, "src", "math.ts"))).digest("hex");
  assert.equal(mathItem?.fileContentHash, `context-file-v1:${mathDigest}`);
  assert.equal(Object.hasOwn(mathItem, "sanitizedContentDigest"), false);

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

test("redacts sensitive values from the generic current-snapshot pack", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const credentialSource = [
    "export function credentials(input) {",
    "  const token = input.token;",
    "  const password = decode(\"copiedcredential123\");",
    "  const refreshToken = decode(",
    "    \"genericmultilinecredential123\"",
    "  );",
    "  return { token, password, refreshToken };",
    "}",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(cwd, "src", "credentials.ts"), credentialSource);
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const pack = await buildContextPack(cwd, "src/credentials.ts credentials token password", {
    budgetTokens: 700,
    currentSnapshot: true,
    excludePatterns: []
  });

  assert.match(pack.text, /src\/credentials\.ts/);
  assert.match(pack.text, /const token = input\.token;/);
  assert.match(pack.text, /const password = \[REDACTED_SECRET\];/);
  assert.doesNotMatch(pack.text, /copiedcredential123|genericmultilinecredential123/);
  const receipt = pack.selected.find((entry) => entry.path === "src/credentials.ts");
  const rawDigest = crypto.createHash("sha256").update(credentialSource).digest("hex");
  const sanitized = redactSensitiveProjectFileText("src/credentials.ts", credentialSource);
  const expectedSanitizedDigest = `context-sanitized-file-v1:${crypto.createHash("sha256").update(sanitized.text).digest("hex")}`;
  assert.equal(receipt?.sensitiveContentRedacted, true);
  assert.equal(receipt?.sanitizedContentDigest, expectedSanitizedDigest);
  assert.equal(receipt?.fileContentHash, expectedSanitizedDigest);
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(rawDigest));

  appendContextTelemetry(cwd, { event: "context_pack_injected", source: "context-tool", selectedItems: [receipt] });
  const persisted = fs.readFileSync(contextEnginePaths(cwd).telemetry, "utf8");
  assert.match(persisted, /context-sanitized-file-v1/);
  assert.doesNotMatch(persisted, new RegExp(rawDigest));
});

test("packs exact graph-selected files without an index, secrets, symlinks, or partial oversized content", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz123456\n");
  fs.writeFileSync(path.join(cwd, ".netrc"), "machine example.test login user password hunter2-secret\n");
  fs.writeFileSync(path.join(cwd, ".pypirc"), "password = pypi-secret-value\n");
  fs.writeFileSync(path.join(cwd, "src", "leaky.ts"), "export const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';\n");
  fs.symlinkSync(path.join(cwd, "src", "math.ts"), path.join(cwd, "src", "linked.ts"));
  const pack = buildSelectedContextPack(cwd, [
    { path: "src/math.ts" }, { path: "src/service.ts" }, { path: ".env" }, { path: ".npmrc" },
    { path: ".netrc" }, { path: ".pypirc" }, { path: "src/leaky.ts" }, { path: "src/linked.ts" }
  ], { budgetTokens: 900, excludePatterns: ["src/service.ts"] });
  assert.deepEqual(pack.selected.map((entry) => entry.path), ["src/math.ts", "src/leaky.ts"]);
  const mathDigest = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, "src", "math.ts"))).digest("hex");
  assert.equal(pack.selected[0].contentDigest, mathDigest);
  assert.equal(pack.selected[0].fileContentHash, `context-file-v1:${mathDigest}`);
  assert.equal(Object.hasOwn(pack.selected[0], "sanitizedContentDigest"), false);
  assert.ok(pack.estimatedTokens <= 900);
  assert.match(pack.text, /criterion context snapshot/);
  assert.match(pack.text, /calculateInvoiceTotal/);
  assert.match(pack.text, /src\/leaky\.ts/);
  assert.match(pack.text, /\[REDACTED_SECRET\]/);
  const redacted = pack.selected.find((entry) => entry.path === "src/leaky.ts");
  const rawLeakyDigest = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, "src", "leaky.ts"))).digest("hex");
  assert.equal(redacted?.sensitiveContentRedacted, true);
  assert.equal(Object.hasOwn(redacted, "contentDigest"), false);
  assert.match(redacted?.sanitizedContentDigest, /^context-sanitized-file-v1:[a-f0-9]{64}$/);
  assert.equal(redacted?.fileContentHash, redacted?.sanitizedContentDigest);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(rawLeakyDigest));
  assert.doesNotMatch(pack.text, /SECRET=|linked\.ts|service\.ts|npm_|hunter2|pypi-secret|sk-proj-/);
  assert.deepEqual(buildSelectedContextPack(cwd, [{ path: "src/math.ts" }], {
    budgetTokens: 900, maxFileBytes: 16, excludePatterns: []
  }), { text: "", selected: [], estimatedTokens: 0 });
});

test("criterion receipts persist only sanitized digests after source redaction", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, "src", "credentials.ts");
  const source = (secret) => `export const apiKey = '${secret}';\n`;
  const firstBytes = Buffer.from(source("sk-proj-abcdefghijklmnopqrstuvwxyz123456"));
  const secondBytes = Buffer.from(source("sk-proj-zyxwvutsrqponmlkjihgfedcba654321"));
  fs.writeFileSync(target, firstBytes);
  const first = buildSelectedContextPack(cwd, [{ path: "src/credentials.ts" }], {
    budgetTokens: 900,
    excludePatterns: []
  }).selected[0];
  fs.writeFileSync(target, secondBytes);
  const second = buildSelectedContextPack(cwd, [{ path: "src/credentials.ts" }], {
    budgetTokens: 900,
    excludePatterns: []
  }).selected[0];
  const rawDigests = [firstBytes, secondBytes]
    .map((bytes) => crypto.createHash("sha256").update(bytes).digest("hex"));

  for (const receipt of [first, second]) {
    assert.equal(receipt.sensitiveContentRedacted, true);
    assert.equal(Object.hasOwn(receipt, "contentDigest"), false);
    assert.match(receipt.sanitizedContentDigest, /^context-sanitized-file-v1:[a-f0-9]{64}$/);
    assert.equal(receipt.fileContentHash, receipt.sanitizedContentDigest);
    for (const rawDigest of rawDigests) assert.doesNotMatch(JSON.stringify(receipt), new RegExp(rawDigest));
  }
  assert.equal(first.sanitizedContentDigest, second.sanitizedContentDigest,
    "changing only the redacted secret must not change the persisted content identity");
  assert.equal(first.payloadHash, second.payloadHash);

  appendContextTelemetry(cwd, { event: "context_pack_injected", selectedItems: [first, second] });
  const persisted = fs.readFileSync(contextEnginePaths(cwd).telemetry, "utf8");
  assert.match(persisted, /context-sanitized-file-v1/);
  for (const rawDigest of rawDigests) assert.doesNotMatch(persisted, new RegExp(rawDigest));
});

test("keeps auth source semantics while redacting embedded credential literals", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "auth.ts"), [
    "export function authenticate(request, input) {",
    "  const password = request.password;",
    "  const token = input.token;",
    "  const refreshToken = config[\"token\"];",
    "  const accessToken = process.env[\"API_TOKEN\"];",
    "  const sessionToken = getToken(request);",
    "  const configToken = config.get(\"token\");",
    "  const fallbackToken = config.get(\"token\", input.fallbackToken);",
    "  const selectedToken = input.token || input.fallbackToken;",
    "  const decodedToken = decode(\"hunter2-secret\");",
    "  const bufferedToken = Buffer.from(\"hunter2-secret\");",
    "  const multilineToken = decode(",
    "    \"multilinecredential123\"",
    "  );",
    "  const splitCallToken = decode",
    "  (",
    "    \"splitcallcredential123\"",
    "  );",
    "  const coalescedToken = input.token ??",
    "    \"coalescedcredential123\";",
    "  const awaitedToken = await",
    "    getToken(\"awaitedcredential123\");",
    "  config[\"token\"] = input.token;",
    "  process.env[\"API_TOKEN\"] = \"compoundcredential123\";",
    "  headers[\"Authorization\"] = \"Bearer copiedauthorization123\";",
    "  obj?.token ||= \"optionalcredential123\";",
    "  const computed = { [\"token\"]: \"computedcredential123\" };",
    "  config.set(\"token\", input.token);",
    "  map.put(\"token\", \"settercredential123\");",
    "  setToken(input.token);",
    "  setPassword(\"directsettercredential123\");",
    "  const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';",
    "  // password = copiedcredential123",
    "  /* api_key = abcdefghijklmnop */",
    "  /* comment */ const ownerToken = request.ownerToken;",
    "  const __PIAGENT_DSR_0_0__ = 'original-marker-like-source';",
    "  const endpoint = \"https://example.test/#auth\"; const routedToken = input.routedToken;",
    "  const ternaryToken = input.enabled ? input.token : input.fallbackToken;",
    "  return { password, token, refreshToken, accessToken, sessionToken, configToken, fallbackToken, selectedToken, ternaryToken, ownerToken, routedToken, endpoint, apiKey };",
    "}",
    ""
  ].join("\n"));

  const pack = buildSelectedContextPack(cwd, [{ path: "src/auth.ts" }], {
    budgetTokens: 900,
    excludePatterns: []
  });

  assert.deepEqual(pack.selected.map((entry) => entry.path), ["src/auth.ts"]);
  assert.match(pack.text, /const password = request\.password;/);
  assert.match(pack.text, /const token = input\.token;/);
  assert.match(pack.text, /const refreshToken = config\["token"\];/);
  assert.match(pack.text, /const accessToken = process\.env\["API_TOKEN"\];/);
  assert.match(pack.text, /const sessionToken = getToken\(request\);/);
  assert.match(pack.text, /const configToken = config\.get\("token"\);/);
  assert.match(pack.text, /const fallbackToken = config\.get\("token", input\.fallbackToken\);/);
  assert.match(pack.text, /const selectedToken = input\.token \|\| input\.fallbackToken;/);
  assert.match(pack.text, /const ternaryToken = input\.enabled \? input\.token : input\.fallbackToken;/);
  assert.match(pack.text, /config\["token"\] = input\.token;/);
  assert.match(pack.text, /config\.set\("token", input\.token\);/);
  assert.match(pack.text, /setToken\(input\.token\);/);
  assert.match(pack.text, /\/\* comment \*\/ const ownerToken = request\.ownerToken;/);
  assert.match(pack.text, /const __PIAGENT_DSR_0_0__ = 'original-marker-like-source';/);
  assert.match(pack.text, /const endpoint = "https:\/\/example\.test\/#auth"; const routedToken = input\.routedToken;/);
  assert.match(pack.text, /const apiKey = \[REDACTED_SECRET\];/);
  assert.match(pack.text, /\/\* api_key = \[REDACTED_SECRET\] \*\//);
  assert.doesNotMatch(pack.text, /copiedcredential123|abcdefghijklmnop|hunter2-secret|multilinecredential123|splitcallcredential123|coalescedcredential123|awaitedcredential123|compoundcredential123|copiedauthorization123|optionalcredential123|computedcredential123|settercredential123|directsettercredential123/);
  assert.doesNotMatch(pack.text, /sk-proj-/);
  assert.equal(pack.selected[0].sensitiveContentRedacted, true);
});

test("redacts Go and PHP credential literals while retaining dynamic references", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "auth.go"), [
    "token := request.Token",
    "password := \"hunter2-secret\"",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "auth.php"), [
    "$token = $requestToken;",
    "$password = \"hunter2-secret\";",
    ""
  ].join("\n"));
  const pack = buildSelectedContextPack(cwd, [{ path: "src/auth.go" }, { path: "src/auth.php" }], {
    budgetTokens: 900,
    excludePatterns: []
  });

  assert.match(pack.text, /token := request\.Token/);
  assert.match(pack.text, /\$token = \$requestToken;/);
  assert.doesNotMatch(pack.text, /hunter2-secret/);
  assert.equal((pack.text.match(/\[REDACTED_SECRET\]/g) ?? []).length, 2);
});

test("redacts supported compound, private-field, nested-setter, heredoc, R, C++ and preprocessor secret syntax", () => {
  const samples = [
    {
      path: "src/auth.ts",
      source: [
        "token += \"compoundcredential123\";",
        "config[\"token\"] ^= \"bitwisecredential123\";",
        "class Vault { #token = \"privatecredential123\"; update() { this.#token *= \"scaledcredential123\"; } }",
        "foo(setToken(\"nestedcredential123\"), setPassword(\"nestedpassword123\"));",
        "foo(setToken(input.token), setPassword(request.password));",
        "class DynamicVault { #token = input.token; }"
      ].join("\n"),
      retained: [/setToken\(input\.token\)/, /setPassword\(request\.password\)/, /#token = input\.token/]
    },
    {
      path: "src/auth.rb",
      source: [
        "token = %q(percentcredential123)",
        "password = <<~SECRET",
        "descriptive body line",
        "heredoccredential123",
        "SECRET",
        "dynamic_token = request.token"
      ].join("\n"),
      retained: [/dynamic_token = request\.token/]
    },
    {
      path: "src/typed-auth.go",
      source: "var token string = \"gotypedcredential123\"\nconst apiKey []byte = \"gotypedapikey123\"\nvar dynamicToken string = os.Getenv(\"TOKEN\")",
      retained: [/var dynamicToken string = os\.Getenv\("TOKEN"\)/]
    },
    { path: "src/auth.r", source: "token <- \"rcredential123\"\ndynamic_token <- request.token", retained: [/dynamic_token <- request\.token/] },
    { path: "src/auth.cpp", source: "std::string token{\"cppcredential123\"};\nstd::string dynamicToken{request.token};", retained: [/dynamicToken\{request\.token\}/] },
    { path: "src/auth.h", source: "#define API_TOKEN \"macrocredential123\"\n#define PASSWORD INPUT_PASSWORD", retained: [/#define PASSWORD INPUT_PASSWORD/] }
  ];
  const forbidden = /compoundcredential123|bitwisecredential123|privatecredential123|scaledcredential123|nestedcredential123|nestedpassword123|percentcredential123|heredoccredential123|gotypedcredential123|gotypedapikey123|rcredential123|cppcredential123|macrocredential123/;

  for (const sample of samples) {
    const result = redactSensitiveProjectFileText(sample.path, sample.source);
    assert.equal(result.redacted, true, sample.path);
    assert.equal(result.lineCountPreserved, true, sample.path);
    assert.doesNotMatch(result.text, forbidden, sample.path);
    for (const pattern of sample.retained) assert.match(result.text, pattern, sample.path);
  }

  for (const [filePath, declaration] of [
    ["src/types.cpp", "struct Token { const char* kind = \"access\"; int value; };"],
    ["src/types.ts", "interface Token { kind: \"access\"; value: number; }"],
    ["src/types.java", "public final class Credentials { String kind = \"access\"; }"]
  ]) {
    assert.deepEqual(redactSensitiveProjectFileText(filePath, declaration), {
      text: declaration,
      redacted: false,
      lineCountPreserved: true
    });
  }
});

test("redacts short and numeric structured literals while retaining only pure dynamic references", () => {
  const samples = [
    {
      path: "config/auth.yaml",
      source: "token: abc123\npassword: 7\nrefresh_token: ${TOKEN_REF}\nrequest_token: request.token\nfallback_token: ${TOKEN_REF:-abc123}\n",
      retained: [/refresh_token: \$\{TOKEN_REF\}/, /request_token: request\.token/]
    },
    {
      path: "config/auth.xml",
      source: "<auth><token>abc123</token><password>7</password><refresh-token>${TOKEN_REF}</refresh-token></auth>",
      retained: [/<refresh-token>\$\{TOKEN_REF\}<\/refresh-token>/]
    },
    {
      path: "public/auth.html",
      source: "<auth-panel token=abc123 api-key=\"abc>def\" password=7 :refresh-token=\"requestToken\"></auth-panel>",
      retained: [/:refresh-token=\"requestToken\"/]
    },
    {
      path: "styles/auth.css",
      source: ":root { --api-token: abc123; --password: 7; --client-secret:\n  42\n; --refresh-token: var(--token-ref); }",
      retained: [/--refresh-token: var\(--token-ref\)/]
    },
    {
      path: "ios/AuthClient.mm",
      source: "NSString *password = @\"x\";\nNSNumber *token = @7;\nNSArray *apiKey = @[@\"a\", @1];\nNSDictionary *values = @{@\"private_key\": @[@\"literal\", @1]};\nNSString *refreshToken = request.token;\nNSString *accessToken = config[@\"token\"];\nNSString *sessionToken = [request token];",
      retained: [
        /NSString \*refreshToken = request\.token;/,
        /NSString \*accessToken = config\[@\"token\"\];/,
        /NSString \*sessionToken = \[request token\];/
      ]
    },
    {
      path: "src/auth.ts",
      source: "const token = resolveToken(request.token, 7);\nconst password = request.password || null;\nconst apiKey = config.get(\"token\", \"abc123\");\nconst refreshToken = request.tokens[0];",
      retained: [/const refreshToken = request\.tokens\[0\];/]
    }
  ];

  for (const sample of samples) {
    const result = redactSensitiveProjectFileText(sample.path, sample.source);
    assert.equal(result.redacted, true, sample.path);
    assert.equal(result.lineCountPreserved, true, sample.path);
    assert.doesNotMatch(result.text, /abc123|abc>def|password: 7|token=abc123|password=7|--password: 7|\b42\b|@\"x\"|token = @7|@\[@\"a\"|@\"literal\"|resolveToken|request\.password \|\| null/, sample.path);
    for (const pattern of sample.retained) assert.match(result.text, pattern, sample.path);
  }

  for (const source of ["/*hello*/", "const value = 1; /* comment */"]) {
    assert.deepEqual(redactSensitiveProjectFileText("src/noop.ts", source), {
      text: source,
      redacted: false,
      lineCountPreserved: true
    });
  }
});

test("bounds deeply nested ordinary and non-sensitive setter call sanitization", () => {
  const depth = 20_000;
  for (const source of [
    `${"wrap(".repeat(depth)}value${")".repeat(depth)}`,
    `${"set(\"public\",".repeat(depth)}value${")".repeat(depth)}`
  ]) {
    const startedAt = performance.now();
    const result = redactSensitiveProjectFileText("src/deep.ts", source);
    assert.equal(result.text, source);
    assert.equal(result.redacted, false);
    assert.ok(performance.now() - startedAt < 1_000, "nested call sanitization should remain bounded");
  }
});

test("keeps dynamic shell and SQL references but strictly redacts comment examples", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "auth.sh"), [
    "token=$INPUT_TOKEN",
    "refresh_token=$(get-token)",
    "access_token=${INPUT_TOKEN:-\"shellfallbackcredential123\"}",
    "api_key=$(printf %s \"shellcommandcredential123\")",
    "password=hunter2-secret",
    "# token = copiedshellcredential",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "auth.sql"), [
    "password = users.password;",
    "-- password = copiedsqlcredential",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "auth.py"), [
    "password = request.password",
    "# password = copiedpythoncredential",
    ""
  ].join("\n"));
  const pack = buildSelectedContextPack(cwd, [
    { path: "src/auth.sh" }, { path: "src/auth.sql" }, { path: "src/auth.py" }
  ], {
    budgetTokens: 900,
    excludePatterns: []
  });

  assert.match(pack.text, /token=\$INPUT_TOKEN/);
  assert.match(pack.text, /refresh_token=\$\(get-token\)/);
  assert.match(pack.text, /password = users\.password;/);
  assert.match(pack.text, /password = request\.password/);
  assert.doesNotMatch(pack.text, /hunter2-secret|copiedshellcredential|copiedsqlcredential|copiedpythoncredential|shellfallbackcredential123|shellcommandcredential123/);
  assert.equal(pack.selected.every((entry) => entry.sensitiveContentRedacted), true);
});

test("composes one criterion-aware initial pack without unrelated graph-only siblings", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "src", "unrelated.ts"), "export const unrelated = true;\n");
  fs.writeFileSync(path.join(cwd, "tests", "unrelated.test.ts"), "test('unrelated', () => {});\n");
  const entries = composeCriterionContextEntries({
    explicitPaths: ["src/math.ts"],
    criteria: ["Preserve calculateInvoiceTotal behavior and prove it with the nearest focused test."],
    retrievedItems: [
      { path: "src/math.ts", sources: ["explicit", "lexical"], ranges: [{ start: 1, end: 3 }] },
      { path: "src/unrelated.ts", sources: ["graph"] },
      { path: "tests/math.test.ts", sources: ["graph"] },
      { path: "tests/unrelated.test.ts", sources: ["graph"] }
    ],
    plannedEntries: [
      { path: "src/math.ts", reason: "criterion-01 behavior target" },
      { path: "src/unrelated.ts", reason: "criterion-01 behavior target" },
      { path: "tests/math.test.ts", reason: "criterion-02 verification target" },
      { path: "tests/unrelated.test.ts", reason: "criterion-02 verification target" }
    ]
  }, { limit: 6 });

  assert.deepEqual(entries.map((entry) => entry.path), ["src/math.ts", "tests/math.test.ts"]);
  assert.deepEqual(entries[0].ranges, [{ start: 1, end: 3 }], "exact targets retain bounded retrieval ranges");

  const pack = buildSelectedContextPack(cwd, entries, {
    budgetTokens: 420,
    focusText: "calculateInvoiceTotal behavior nearest focused test",
    excludePatterns: []
  });
  assert.deepEqual(pack.selected.map((entry) => entry.path), ["src/math.ts", "tests/math.test.ts"]);
  assert.ok(pack.estimatedTokens <= 420);
  assert.doesNotMatch(pack.text, /unrelated/);
  for (const item of pack.selected) {
    assert.match(item.fileContentHash, /^context-file-v1:[a-f0-9]{64}$/);
    assert.match(item.payloadHash, /^context-payload-v1:[a-f0-9]{64}$/);
    assert.ok(["full", "snippet"].includes(item.representation));
    assert.ok(Array.isArray(item.ranges));
    assert.equal(item.generation, 1);
  }
});

test("falls back to one planned criterion source and its focused test when retrieval is missing or stale", () => {
  const plannedEntries = [
    { path: "src/invoice.ts", reason: "criterion-01 behavior target" },
    { path: "tests/invoice.test.ts", reason: "criterion-02 verification target" },
    { path: "src/unrelated.ts", reason: "criterion-01 broad-scope target" }
  ];
  for (const retrievedItems of [
    [],
    [{ path: "src/unrelated.ts", sources: ["graph"] }]
  ]) {
    const entries = composeCriterionContextEntries({
      explicitPaths: [],
      criteria: ["Preserve rounding and prove zero-total behavior."],
      plannedEntries,
      retrievedItems
    }, { limit: 4 });
    assert.deepEqual(entries.map((entry) => entry.path), ["src/invoice.ts", "tests/invoice.test.ts"]);
  }
});

test("delivers the sole scoped executable test and rejects unrelated retrieval for an explicit source", () => {
  const entries = composeCriterionContextEntries({
    explicitPaths: ["src/reliability/expiry.js"],
    criteria: ["Reject malformed expiry values with TypeError and add durable focused coverage."],
    plannedEntries: [
      { path: "src/reliability/expiry.js", reason: "criterion-01 boundary target" },
      { path: "test/smoke.test.js", reason: "criterion-01 test scope target" }
    ],
    plannedSelectionComplete: true,
    retrievedItems: [
      { path: "src/platform/workspace.js", sources: ["lexical"] }
    ]
  }, { limit: 3 });

  assert.deepEqual(entries.map((entry) => entry.path), [
    "src/reliability/expiry.js",
    "test/smoke.test.js"
  ]);
  assert.match(entries[1].reason, /Sole proven scoped test target.*not acceptance proof/);
});

test("prefers a proven direct import neighbor over singleton fallback and rejects a symbol collision", () => {
  const linked = composeCriterionContextEntries({
    explicitPaths: ["src/backend/auth.js"],
    criteria: ["Preserve canManage authorization behavior."],
    plannedEntries: [
      { path: "src/backend/auth.js", reason: "criterion source" },
      { path: "test/smoke.test.js", reason: "test scope" }
    ],
    plannedSelectionComplete: true,
    retrievedItems: [{
      path: "lib/identity/tenant.js",
      sources: ["import"],
      links: [{ kind: "explicit-imports-candidate", path: "src/backend/auth.js" }]
    }]
  }, { limit: 2 });
  assert.deepEqual(linked.map((entry) => entry.path), ["src/backend/auth.js", "lib/identity/tenant.js"]);

  const collision = composeCriterionContextEntries({
    explicitPaths: ["src/backend/auth.js"],
    criteria: ["Preserve canManage authorization behavior."],
    plannedEntries: [{ path: "src/backend/auth.js", reason: "criterion source" }],
    plannedSelectionComplete: true,
    retrievedItems: [{ path: "lib/identity/tenant.js", sources: ["symbol"] }]
  }, { limit: 3 });
  assert.deepEqual(collision.map((entry) => entry.path), ["src/backend/auth.js"]);

  const sameStemCollision = composeCriterionContextEntries({
    explicitPaths: ["src/a/user.ts"],
    criteria: ["Preserve the user lookup."],
    plannedEntries: [{ path: "src/a/user.ts", reason: "criterion source" }],
    plannedSelectionComplete: true,
    retrievedItems: [{ path: "src/b/user.ts", sources: ["symbol"] }]
  }, { limit: 3 });
  assert.deepEqual(sameStemCollision.map((entry) => entry.path), ["src/a/user.ts"]);

  const sameStemTestCollision = composeCriterionContextEntries({
    explicitPaths: ["src/a/user.ts"],
    criteria: ["Preserve user lookup behavior."],
    plannedEntries: [{ path: "src/a/user.ts", reason: "criterion source" }],
    plannedSelectionComplete: false,
    retrievedItems: [{ path: "packages/other/user.test.ts", sources: ["lexical"] }]
  }, { limit: 3 });
  assert.deepEqual(sameStemTestCollision.map((entry) => entry.path), ["src/a/user.ts"]);

  const ownerPair = (source, focusedTest) => composeCriterionContextEntries({
    explicitPaths: [source],
    criteria: ["Preserve lookup behavior with focused coverage."],
    plannedEntries: [{ path: source, reason: "criterion source" }],
    plannedSelectionComplete: false,
    retrievedItems: [{ path: focusedTest, sources: ["lexical"] }]
  }, { limit: 3 }).map((entry) => entry.path);
  assert.deepEqual(ownerPair("src/user.ts", "tests/user.test.ts"), ["src/user.ts", "tests/user.test.ts"]);
  assert.deepEqual(ownerPair("src/user.ts", "tests/unrelated.test.ts"), ["src/user.ts"]);
  assert.deepEqual(ownerPair("packages/team/a/src/user.ts", "packages/team/a/tests/user.test.ts"), [
    "packages/team/a/src/user.ts", "packages/team/a/tests/user.test.ts"
  ]);
  assert.deepEqual(ownerPair("packages/team/a/src/user.ts", "packages/team/b/tests/user.test.ts"), ["packages/team/a/src/user.ts"]);
  assert.deepEqual(ownerPair("src/features/a/user.ts", "tests/features/b/user.test.ts"), ["src/features/a/user.ts"]);
  assert.deepEqual(ownerPair("apps/foo/src/user.ts", "packages/foo/tests/user.test.ts"), ["apps/foo/src/user.ts"]);
  assert.deepEqual(ownerPair("packages/lib/src/user.ts", "packages/lib/tests/user.test.ts"), [
    "packages/lib/src/user.ts", "packages/lib/tests/user.test.ts"
  ]);
  assert.deepEqual(ownerPair("packages/app/src/user.ts", "packages/test/src/user.test.ts"), ["packages/app/src/user.ts"]);
  assert.deepEqual(ownerPair("packages/lib/src/user.ts", "packages/tests/src/user.test.ts"), ["packages/lib/src/user.ts"]);
  assert.deepEqual(ownerPair("apps/app/src/user.ts", "apps/test/src/user.test.ts"), ["apps/app/src/user.ts"]);
  assert.deepEqual(ownerPair("modules/lib/src/user.ts", "modules/lib/tests/user.test.ts"), [
    "modules/lib/src/user.ts", "modules/lib/tests/user.test.ts"
  ]);
  assert.deepEqual(ownerPair("modules/app/src/user.ts", "modules/test/src/user.test.ts"), ["modules/app/src/user.ts"]);
  assert.deepEqual(ownerPair("packages/src/lib/user.ts", "packages/lib/src/user.test.ts"), ["packages/src/lib/user.ts"]);
  assert.deepEqual(ownerPair("apps/src/lib/user.ts", "apps/lib/src/user.test.ts"), ["apps/src/lib/user.ts"]);
  assert.deepEqual(ownerPair("modules/src/lib/user.ts", "modules/lib/src/user.test.ts"), ["modules/src/lib/user.ts"]);
  assert.deepEqual(ownerPair("packages/spec/lib/user.ts", "packages/lib/spec/user.test.ts"), ["packages/spec/lib/user.ts"]);
  assert.deepEqual(ownerPair("packages/foo/lib/src/user.ts", "packages/foo/src/lib/user.test.ts"), ["packages/foo/lib/src/user.ts"]);
  assert.deepEqual(ownerPair("packages/foo/app/src/user.ts", "packages/foo/src/app/user.test.ts"), ["packages/foo/app/src/user.ts"]);
  assert.deepEqual(ownerPair("services/foo/lib/src/user.ts", "services/foo/src/lib/user.test.ts"), ["services/foo/lib/src/user.ts"]);
  assert.deepEqual(ownerPair("lib/src/user.ts", "src/lib/user.test.ts"), ["lib/src/user.ts"]);
  assert.deepEqual(ownerPair("app/src/user.ts", "src/app/user.test.ts"), ["app/src/user.ts"]);
  assert.deepEqual(ownerPair("packages/lib/src/user.ts", "packages/lib/tests/user.test.ts"), [
    "packages/lib/src/user.ts", "packages/lib/tests/user.test.ts"
  ]);
  assert.deepEqual(ownerPair("src/lib/user.ts", "tests/lib/user.test.ts"), ["src/lib/user.ts", "tests/lib/user.test.ts"]);
  assert.deepEqual(ownerPair("src/app/user.ts", "tests/app/user.test.ts"), ["src/app/user.ts", "tests/app/user.test.ts"]);
  assert.deepEqual(ownerPair("packages/foo/src/lib/user.ts", "packages/foo/tests/lib/user.test.ts"), [
    "packages/foo/src/lib/user.ts", "packages/foo/tests/lib/user.test.ts"
  ]);

  const directlyLinkedTest = composeCriterionContextEntries({
    explicitPaths: ["src/data/csv.js"],
    criteria: ["Throw SyntaxError for malformed CSV."],
    plannedEntries: [{ path: "src/data/csv.js", reason: "criterion source" }],
    plannedSelectionComplete: false,
    retrievedItems: [{
      path: "test/parser.test.js",
      sources: ["import"],
      links: [{ kind: "candidate-imports-explicit", path: "src/data/csv.js" }]
    }]
  }, { limit: 2 });
  assert.deepEqual(directlyLinkedTest.map((entry) => entry.path), ["src/data/csv.js", "test/parser.test.js"]);
});

test("does not promote directory-qualified basename collisions or bare package imports", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src", "b"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "packages", "nested", "src", "a"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "lib"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a", "config.ts"), "export const aConfig = true;\n");
  fs.writeFileSync(path.join(cwd, "src", "b", "config.ts"), "export const bConfig = true;\n");
  fs.writeFileSync(path.join(cwd, "packages", "nested", "src", "a", "config.ts"), "export const nestedConfig = true;\n");
  fs.writeFileSync(path.join(cwd, "src", "controller.ts"), "import express from 'express'; export const app = express;\n");
  fs.writeFileSync(path.join(cwd, "lib", "express.ts"), "export const localExpress = true;\n");
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const qualified = await searchContextIndexV2(cwd, "Inspect src/a/config.ts", { limit: 12, excludePatterns: [] });
  assert.ok(qualified.results.find((entry) => entry.path === "src/a/config.ts")?.sources.includes("explicit"));
  assert.equal(qualified.results.find((entry) => entry.path === "src/b/config.ts")?.sources.includes("explicit") ?? false, false);
  assert.equal(qualified.results.find((entry) => entry.path === "packages/nested/src/a/config.ts")?.sources.includes("explicit") ?? false, false);
  const composed = composeCriterionContextEntries({
    explicitPaths: ["src/a/config.ts"],
    criteria: ["Change only src/a/config.ts and preserve its behavior."],
    plannedEntries: [{ path: "src/a/config.ts", reason: "criterion source" }],
    plannedSelectionComplete: false,
    retrievedItems: qualified.results
  }, { limit: 4 });
  assert.deepEqual(composed.map((entry) => entry.path), ["src/a/config.ts"]);

  const packageImport = await searchContextIndexV2(cwd, "Inspect src/controller.ts", { limit: 12, excludePatterns: [] });
  const localCollision = packageImport.results.find((entry) => entry.path === "lib/express.ts");
  assert.equal(localCollision?.sources.includes("import") ?? false, false);
  assert.deepEqual(localCollision?.links ?? [], []);
});

test("derives direct import links only from executable JavaScript module syntax", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "target.ts"), [
    "// import { commented } from './commented';",
    "const documentation = \"require('./documented')\";",
    "const template = `import('./templated')`;",
    "const templateExpression = `${import('./template-expression')}`;",
    "const pattern = /import\(\".\\/regex-decoy\"\)/;",
    "if (true) /import(\".\\/control-regex-decoy\")/.test('');",
    "const afterBlockComment = true ? /* erased before regex classification */ /import(\".\\/block-regex-decoy\")/ : /unused/;",
    "if (true) {} /import(\".\\/block-close-regex-decoy\")/;",
    "/* const ignored = import('./blocked'); */",
    "import { esm } from './esm';",
    "import './side-effect';",
    "const cjs = require('./cjs');",
    "const dynamic = import('./dynamic');",
    "export { reexported } from './reexported';",
    "export const target = { esm, cjs, dynamic };"
  ].join("\n"));
  for (const name of ["commented", "documented", "templated", "template-expression", "regex-decoy", "control-regex-decoy", "block-regex-decoy", "block-close-regex-decoy", "blocked", "esm", "side-effect", "cjs", "dynamic", "reexported"]) {
    fs.writeFileSync(path.join(cwd, "src", `${name}.ts`), `export const ${name.replaceAll("-", "_")} = true;\n`);
  }
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const result = await searchContextIndexV2(cwd, "Inspect src/target.ts", { limit: 20, excludePatterns: [] });
  const direct = new Set(result.results
    .filter((entry) => entry.links?.some((link) => link.path === "src/target.ts"))
    .map((entry) => entry.path));
  assert.deepEqual([...direct].sort(), [
    "src/cjs.ts", "src/dynamic.ts", "src/esm.ts", "src/reexported.ts", "src/side-effect.ts", "src/template-expression.ts"
  ]);
  for (const decoy of ["src/blocked.ts", "src/commented.ts", "src/documented.ts", "src/templated.ts", "src/regex-decoy.ts", "src/control-regex-decoy.ts", "src/block-regex-decoy.ts", "src/block-close-regex-decoy.ts"]) {
    assert.equal(direct.has(decoy), false);
  }
});

test("does not treat JSX text or a shadowed require binding as a module edge", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "view.tsx"), [
    "const require = (value: string) => value;",
    "const shadowed = require('./shadowed');",
    "export const View = () => <section>",
    "  import(\"./jsx-text\")",
    "  <span>require(\"./nested-jsx-text\")</span>",
    "  {import('./jsx-expression')}",
    "</section>;"
  ].join("\n"));
  for (const name of ["shadowed", "jsx-text", "nested-jsx-text", "jsx-expression"]) {
    fs.writeFileSync(path.join(cwd, "src", `${name}.ts`), `export const ${name.replaceAll("-", "_")} = true;\n`);
  }
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const result = await searchContextIndexV2(cwd, "Inspect src/view.tsx", { limit: 20, excludePatterns: [] });
  const direct = new Set(result.results
    .filter((entry) => entry.links?.some((link) => link.path === "src/view.tsx"))
    .map((entry) => entry.path));
  assert.deepEqual([...direct], ["src/jsx-expression.ts"]);
});

test("classifies a large JSX text corpus without rescanning from byte zero per import decoy", () => {
  const rows = ["export const View = () => <section>"];
  for (let index = 0; index < 8_000; index += 1) rows.push(`import(\"./decoy-${index}\")`);
  rows.push("{import('./live')}", "</section>;");
  const startedAt = performance.now();
  const imports = extractJavaScriptModuleImports(rows.join("\n"), { jsx: true });
  const elapsed = performance.now() - startedAt;
  assert.deepEqual(imports, [{ specifier: "./live", line: 8_002 }]);
  assert.ok(elapsed < 1_500, `large JSX lexical classification took ${elapsed.toFixed(1)}ms`);
});

test("fails closed when imports or compound assignments shadow CommonJS require", () => {
  const specifiers = (source) => extractJavaScriptModuleImports(source).map((entry) => entry.specifier);
  assert.deepEqual(specifiers([
    "const value = `raw import('./raw-decoy') ${flag ? import('./live') : `nested ${import('./nested-live')}`}`;",
    "const escaped = `\\${import('./escaped-decoy')}`;"
  ].join("\n")), ["./live", "./nested-live"]);
  assert.deepEqual(specifiers("const malformed = `${import('./unclosed')"), []);
  assert.deepEqual(specifiers("import require from './shim'; require('./decoy');"), ["./shim"]);
  assert.deepEqual(specifiers("import { require } from './shim'; require('./decoy');"), ["./shim"]);
  assert.deepEqual(specifiers("import { loader as require } from './shim'; require('./decoy');"), ["./shim"]);
  for (const operator of ["||=", "??=", "&&=", "+=", "**="]) {
    assert.deepEqual(specifiers(`require ${operator} loader; require('./decoy');`), []);
  }
});

test("ignores script-tag examples inside Vue comments while retaining the live SFC script", async (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "component.vue"), [
    "<!--",
    "<script>import { decoy } from './vue-decoy';</script>",
    "-->",
    "<script setup lang=\"ts\">",
    "import { live } from './vue-live';",
    "</script>",
    "<template><p>{{ live }}</p></template>"
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "vue-decoy.ts"), "export const decoy = true;\n");
  fs.writeFileSync(path.join(cwd, "src", "vue-live.ts"), "export const live = true;\n");
  await buildContextIndexV2(cwd, { excludePatterns: [] });

  const result = await searchContextIndexV2(cwd, "Inspect src/component.vue", { limit: 20, excludePatterns: [] });
  const direct = new Set(result.results
    .filter((entry) => entry.links?.some((link) => link.path === "src/component.vue"))
    .map((entry) => entry.path));
  assert.deepEqual([...direct], ["src/vue-live.ts"]);
});

test("stops embedded imports at script end tags with ignored HTML attributes", () => {
  const source = [
    "<script>",
    "import './first-live';",
    "</script\t",
    " data-extra>",
    "<template>import('./template-decoy')</template>",
    "<script type=\"module\">",
    "const marker = '</script-x>';",
    "import './second-live';",
    "</script/ignored>",
    "<template>require('./second-decoy')</template>",
    "<script-x>import('./custom-element-decoy')</script-x>"
  ].join("\n");

  assert.deepEqual(extractJavaScriptModuleImports(source, { embedded: true }), [
    { specifier: "./first-live", line: 2 },
    { specifier: "./second-live", line: 8 }
  ]);
});

test("does not guess among incomplete or multiple scoped tests or treat setup and neutral fixtures as executable", () => {
  const common = {
    explicitPaths: ["src/data/csv.js"],
    criteria: ["Throw SyntaxError for malformed CSV and add durable focused coverage."],
    retrievedItems: []
  };
  const ambiguous = composeCriterionContextEntries({
    ...common,
    plannedSelectionComplete: true,
    plannedEntries: [
      { path: "src/data/csv.js", reason: "criterion source" },
      { path: "test/a.test.js", reason: "test scope" },
      { path: "test/b.test.js", reason: "test scope" }
    ]
  }, { limit: 4 });
  assert.deepEqual(ambiguous.map((entry) => entry.path), ["src/data/csv.js"]);

  const neutral = composeCriterionContextEntries({
    ...common,
    plannedSelectionComplete: true,
    plannedEntries: [
      { path: "src/data/csv.js", reason: "criterion source" },
      { path: "test/README.md", reason: "test scope" }
    ]
  }, { limit: 4 });
  assert.deepEqual(neutral.map((entry) => entry.path), ["src/data/csv.js"]);

  const setup = composeCriterionContextEntries({
    ...common,
    plannedSelectionComplete: true,
    plannedEntries: [
      { path: "src/data/csv.js", reason: "criterion source" },
      { path: "test/setup.js", reason: "test scope" }
    ]
  }, { limit: 4 });
  assert.deepEqual(setup.map((entry) => entry.path), ["src/data/csv.js"]);

  const truncated = composeCriterionContextEntries({
    ...common,
    plannedSelectionComplete: false,
    plannedEntries: [
      { path: "src/data/csv.js", reason: "criterion source" },
      { path: "test/visible.test.js", reason: "truncated test scope" }
    ]
  }, { limit: 4 });
  assert.deepEqual(truncated.map((entry) => entry.path), ["src/data/csv.js"]);
});

test("chooses a proven singleton test before a weak retrieved test match", () => {
  const entries = composeCriterionContextEntries({
    explicitPaths: ["src/feature/value.js"],
    criteria: ["Reject malformed values and add durable focused coverage."],
    plannedEntries: [
      { path: "src/feature/value.js", reason: "criterion source" },
      { path: "test/smoke.test.js", reason: "test scope" }
    ],
    plannedSelectionComplete: true,
    retrievedItems: [{ path: "src/feature/unrelated.test.js", sources: ["lexical"] }]
  }, { limit: 2 });
  assert.deepEqual(entries.map((entry) => entry.path), ["src/feature/value.js", "test/smoke.test.js"]);
});

test("uses a current bounded snippet with a complete receipt when an explicit target is large", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const large = Array.from({ length: 240 }, (_entry, index) => (
    index === 180 ? "export function calculateInvoiceTotal(values) { return values.length; }" : `const filler${index} = ${index};`
  )).join("\n");
  fs.writeFileSync(path.join(cwd, "src", "large.ts"), `${large}\n`);
  const pack = buildSelectedContextPack(cwd, [{
    path: "src/large.ts",
    reason: "Explicit operator target",
    ranges: [{ start: 177, end: 187 }]
  }], {
    budgetTokens: 220,
    focusText: "calculateInvoiceTotal",
    excludePatterns: []
  });

  assert.equal(pack.selected.length, 1);
  assert.equal(pack.selected[0].representation, "snippet");
  assert.deepEqual(pack.selected[0].ranges, [{ start: 177, end: 187 }]);
  assert.match(pack.text, /181: export function calculateInvoiceTotal/);
  assert.match(pack.selected[0].fileContentHash, /^context-file-v1:[a-f0-9]{64}$/);
  assert.match(pack.selected[0].payloadHash, /^context-payload-v1:[a-f0-9]{64}$/);
  assert.equal(pack.selected[0].generation, 1);
  assert.ok(pack.estimatedTokens <= 220);
});

test("omits an oversized target without evidence-qualified ranges instead of injecting arbitrary leading lines", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const large = Array.from({ length: 240 }, (_entry, index) => (
    index === 180 ? "export function calculateInvoiceTotal(values) { return values.length; }" : `import filler${index} from './filler-${index}.js';`
  )).join("\n");
  fs.writeFileSync(path.join(cwd, "src", "large.ts"), `${large}\n`);
  const pack = buildSelectedContextPack(cwd, [{
    path: "src/large.ts",
    reason: "Explicit operator target"
  }], {
    budgetTokens: 220,
    focusText: "anh hãy kiểm tra logic thật kỹ rồi sửa file large",
    excludePatterns: []
  });

  assert.deepEqual(pack, { text: "", selected: [], estimatedTokens: 0 });

  const staleRange = buildSelectedContextPack(cwd, [{
    path: "src/large.ts",
    reason: "Explicit operator target",
    ranges: [{ start: 999, end: 1005 }, { start: -5, end: 2 }, { start: 50, end: 20 }]
  }], {
    budgetTokens: 220,
    excludePatterns: []
  });
  assert.deepEqual(staleRange, { text: "", selected: [], estimatedTokens: 0 });
});

test("does not let later infeasible candidates evict a fitting explicit target", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = Array.from({ length: 70 }, (_entry, index) => `const targetValue${index} = ${index};`).join("\n");
  const oversized = Array.from({ length: 300 }, (_entry, index) => `import dependency${index} from './very-long-unrelated-dependency-${index}.js';`).join("\n");
  fs.writeFileSync(path.join(cwd, "src", "target.ts"), `${target}\n`);
  fs.writeFileSync(path.join(cwd, "src", "oversized-a.ts"), `${oversized}\n`);
  fs.writeFileSync(path.join(cwd, "src", "oversized-b.ts"), `${oversized}\n`);
  const options = { budgetTokens: 800, excludePatterns: [] };
  const entry = { path: "src/target.ts", reason: "Explicit operator target" };

  const solo = buildSelectedContextPack(cwd, [entry], options);
  const crowded = buildSelectedContextPack(cwd, [
    entry,
    { path: "src/oversized-a.ts", reason: "Lower priority without ranges" },
    { path: "src/oversized-b.ts", reason: "Lower priority without ranges" }
  ], options);

  assert.deepEqual(solo.selected.map((item) => item.path), ["src/target.ts"]);
  assert.deepEqual(crowded.selected, solo.selected);
  assert.equal(crowded.text, solo.text);
  assert.ok(crowded.estimatedTokens <= options.budgetTokens);
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
  const readIdentity = { sessionId: "session-1", taskRunId: "run-1", model: "openai/gpt", thinkingLevel: "medium" };
  appendContextTelemetry(cwd, { event: "tool_call", ...readIdentity, toolName: "read", inputHash: "same", targetHash: "same" });
  appendContextTelemetry(cwd, { event: "tool_call", ...readIdentity, toolName: "read", inputHash: "same", targetHash: "same" });
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
  appendContextTelemetry(cwd, {
    event: "tool_result",
    sessionId: "session-1",
    taskRunId: "run-1",
    toolName: "edit",
    targetPath: "src/math.ts",
    isError: false,
    outputChars: 0,
    repeated: false
  });

  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.source, "piagent");
  assert.equal(report.sample.contextPacks, 1);
  assert.equal(report.sample.contextPacksInjected, 2);
  assert.equal(report.metrics.duplicateReads, 1);
  assert.equal(report.metrics.comparableReadCalls, 3);
  assert.equal(report.metrics.readEvidenceCoverage, 1);
  assert.equal(report.metrics.duplicateOutputChars, 1_000);
  assert.equal(report.metrics.comparableToolResults, 3);
  assert.equal(report.metrics.toolResultEvidenceCoverage, 1);
  assert.equal(report.metrics.contextSelections, 2);
  assert.equal(report.metrics.contextSelectionsUsed, 1);
  assert.equal(report.metrics.contextUtilizationRate, 0.5);
  assert.equal(report.metrics.contextFallbackRereads, 1);
  assert.equal(report.metrics.contextFallbackRereadRate, 0.5);
  assert.equal(report.metrics.toolSchemaPrefixShare, 0.1667);
  assert.equal(report.metrics.toolSchemaToSystemRatio, 0.2);
  assert.equal(report.metrics.prefixChangeRate, 0.5);
  assert.equal(report.metrics.averageTurnsPerPrefixEpoch, 1.5);
  assert.equal(report.metrics.duplicateInjectionRate, 0.5);
  assert.equal(report.metrics.duplicateInjectionTokenRate, 0.5);
  assert.ok(report.metrics.contextWasteScore > 0);
  assert.match(report.methodology.note, /not a quality verdict/);
  assert.match(report.methodology.retrievalFeedback, /Positive-only/);
  assert.match(report.methodology.retrievalFeedback, /never increase ranking/);
  assert.equal(report.coverage.reads.status, "complete");
  assert.equal(report.coverage.toolResults.status, "complete");
  assert.equal(report.coverage.contextPacks.status, "complete");
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
  appendContextTelemetry(cwd, {
    event: "tool_call",
    sessionId: "session-feedback",
    taskRunId: "feedback-run",
    toolName: "read",
    targetPath: "src/service.ts"
  });
  appendContextTelemetry(cwd, {
    event: "tool_result",
    sessionId: "session-feedback",
    taskRunId: "feedback-run",
    toolName: "edit",
    targetPath: "src/math.ts",
    isError: false
  });
  appendContextTelemetry(cwd, {
    event: "tool_result",
    sessionId: "session-feedback",
    taskRunId: "feedback-run",
    toolName: "edit",
    targetPath: "src/service.ts",
    isError: true
  });

  const search = await searchContextIndexV2(cwd, "invoice total", {
    limit: 5,
    excludePatterns: []
  });
  const used = search.results.find((result) => result.path === "src/math.ts");
  const unused = search.results.find((result) => result.path === "src/service.ts");
  assert.ok(used?.sources.includes("feedback"));
  assert.equal(unused?.sources.includes("feedback") ?? false, false);
  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.metrics.contextSelectionsMutationCredited, 1);
  assert.equal(report.metrics.contextFallbackRereads, 2);
});

test("read metrics require exact inputs inside one session task model and thinking partition", () => {
  const identity = { sessionId: "session-a", taskRunId: "run-a", model: "openai/gpt", thinkingLevel: "medium" };
  const metrics = readEfficiencyMetrics([
    { event: "tool_call", ...identity, toolName: "read", targetHash: "same-path", inputHash: "range-1" },
    { event: "tool_call", ...identity, toolName: "read", targetHash: "same-path", inputHash: "range-2" },
    { event: "tool_call", ...identity, toolName: "read", targetHash: "same-path", inputHash: "range-1" },
    { event: "tool_call", ...identity, taskRunId: "run-b", toolName: "read", targetHash: "same-path", inputHash: "range-1" },
    { event: "tool_call", ...identity, model: "openai/other", toolName: "read", targetHash: "same-path", inputHash: "range-1" },
    { event: "tool_call", toolName: "read", targetHash: "same-path", inputHash: "range-1" }
  ]);
  assert.equal(metrics.readCalls, 6);
  assert.equal(metrics.comparableReadCalls, 5);
  assert.equal(metrics.uncomparableReadCalls, 1);
  assert.equal(metrics.duplicateReads, 1);
  assert.equal(metrics.duplicateReadRate, 0.2);
  assert.equal(Number(metrics.readEvidenceCoverage.toFixed(4)), 0.8333);
});

test("read metrics do not classify a required post-mutation reread as duplicate waste", () => {
  const identity = { sessionId: "session-a", taskRunId: "run-a", model: "openai/gpt", thinkingLevel: "medium" };
  const metrics = readEfficiencyMetrics([
    { event: "tool_call", ...identity, toolName: "read", targetPath: "src/math.ts", inputHash: "same-range" },
    { event: "tool_result", ...identity, toolName: "edit", targetPath: "src/math.ts", isError: false },
    { event: "tool_call", ...identity, toolName: "read", targetPath: "src/math.ts", inputHash: "same-range" },
    { event: "tool_call", ...identity, toolName: "read", targetPath: "src/math.ts", inputHash: "same-range" }
  ]);
  assert.equal(metrics.readCalls, 3);
  assert.equal(metrics.duplicateReads, 1, "only the unchanged third read is duplicate");
  assert.equal(Number(metrics.duplicateReadRate.toFixed(4)), 0.3333);

  const shellMetrics = readEfficiencyMetrics([
    { event: "tool_call", ...identity, toolName: "read", targetPath: "src/math.ts", inputHash: "same-range" },
    { event: "tool_result", ...identity, toolName: "bash", changedPaths: ["src/math.ts"], isError: false },
    { event: "tool_call", ...identity, toolName: "read", targetPath: "src/math.ts", inputHash: "same-range" }
  ]);
  assert.equal(shellMetrics.duplicateReads, 0, "an observed shell mutation starts a new read-content epoch");
});

test("reports unavailable evidence instead of presenting missing telemetry as zero waste", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  appendContextTelemetry(cwd, { event: "agent_prompt", prefixSurfaceHash: "orphan-prefix" });
  appendContextTelemetry(cwd, { event: "tool_call", toolName: "read", inputHash: "orphan-read" });
  appendContextTelemetry(cwd, {
    event: "context_pack_injected",
    selectedPaths: ["src/math.ts"],
    selectedItems: [{ path: "src/math.ts", estimatedTokens: 20, fileContentHash: "file", payloadHash: "payload", representation: "snippet", ranges: [], generation: 1 }]
  });
  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.metrics.duplicateReadRate, 0);
  assert.equal(report.metrics.readEvidenceCoverage, 0);
  assert.equal(report.coverage.reads.status, "unavailable");
  assert.equal(report.coverage.toolResults.status, "not-observed");
  assert.equal(report.coverage.contextPacks.status, "not-observed");
  assert.equal(report.coverage.prefixPrompts.status, "unavailable");
  assert.equal(report.coverage.injectionReceipts.status, "unavailable");
  assert.equal(report.coverage.injectionItems.status, "unavailable");
  assert.equal(report.coverage.retrievalSelections.status, "unavailable");
  assert.equal(report.metrics.contextWasteScore, null);
  assert.equal(report.coverage.wasteScore.status, "unavailable");
  assert.doesNotMatch(report.recommendations.join("\n"), /No dominant context waste signal/i);
  assert.match(report.recommendations.join("\n"), /coverage is incomplete/i);
});

test("reports partial duplicate-output evidence instead of rewarding unclassified tool results", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 120, repeated: true });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", outputChars: 500 });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "read", repeated: false });
  appendContextTelemetry(cwd, { event: "context_pack", confidence: "low" });
  appendContextTelemetry(cwd, { event: "context_pack" });

  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.metrics.outputChars, 120);
  assert.equal(report.metrics.duplicateOutputChars, 120);
  assert.equal(report.metrics.duplicateOutputRate, 1);
  assert.equal(report.metrics.comparableToolResults, 1);
  assert.equal(report.metrics.uncomparableToolResults, 2);
  assert.equal(report.metrics.toolResultEvidenceCoverage, 0.3333);
  assert.deepEqual(report.coverage.toolResults, { status: "partial", observed: 3, comparable: 1, rate: 0.3333 });
  assert.equal(report.metrics.lowConfidenceRate, 1);
  assert.equal(report.metrics.contextPackEvidenceCoverage, 0.5);
  assert.deepEqual(report.coverage.contextPacks, { status: "partial", observed: 2, comparable: 1, rate: 0.5 });
  assert.ok(report.metrics.contextWasteScoreEvidenceCoverage < 0.4);
  assert.equal(report.metrics.contextWasteScore, null);
  assert.equal(typeof report.metrics.contextWasteScoreEstimate, "number");
  assert.match(report.recommendations.join("\n"), /tool-result telemetry coverage is incomplete/i);
});

test("aggregates edit recovery context independently with explicit evidence coverage", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  appendContextTelemetry(cwd, {
    event: "session_start",
    sessionId: "session-a",
    editRecoveryContextTelemetryVersion: 1
  });
  appendContextTelemetry(cwd, { event: "tool_result", toolName: "edit", outputChars: 40, repeated: false });
  appendContextTelemetry(cwd, {
    event: "edit_recovery_context",
    sessionId: "session-a",
    taskRunId: "task-a",
    toolCallId: "edit-a",
    targetPath: "src/value.ts",
    contentHash: "a".repeat(64),
    originalChars: 240,
    injectedChars: 400,
    injectedEstimatedTokens: 180,
    sensitiveContentRedacted: false
  });
  appendContextTelemetry(cwd, {
    event: "tool_result",
    sessionId: "session-a",
    taskRunId: "task-a",
    toolCallId: "edit-a",
    toolName: "edit",
    targetPath: "src/value.ts",
    isError: true,
    reasonCode: "edit-anchor-stale",
    editRecoveryContext: true,
    editRecoveryInjectedChars: 400,
    editRecoveryEstimatedTokens: 180
  });
  appendContextTelemetry(cwd, {
    event: "edit_recovery_context",
    sessionId: "session-a",
    taskRunId: "task-a",
    toolCallId: "edit-orphan",
    targetPath: "src/orphan.ts",
    contentHash: "b".repeat(64),
    originalChars: 100,
    injectedChars: 200,
    injectedEstimatedTokens: 80,
    sensitiveContentRedacted: false
  });

  const report = buildContextEfficiencyReport(cwd);
  assert.equal(report.sample.editRecoveryContexts, 2);
  assert.equal(report.metrics.editRecoveryContextCount, 1);
  assert.equal(report.metrics.editRecoveryInjectedChars, 400);
  assert.equal(report.metrics.editRecoveryEstimatedTokens, 180);
  assert.equal(report.metrics.editRecoveryFailures, 1);
  assert.equal(report.metrics.comparableEditRecoveryFailures, 1);
  assert.equal(report.metrics.editRecoverySuppressedFailures, 0);
  assert.equal(report.metrics.outputChars, 40, "recovery context must not be folded into original tool output");
  assert.deepEqual(report.coverage.editRecoveryContexts, {
    status: "partial",
    observed: 2,
    comparable: 1,
    rate: 0.5
  });
  assert.deepEqual(report.coverage.editRecoveryFailures, {
    status: "complete",
    observed: 1,
    comparable: 1,
    rate: 1
  });
  assert.match(report.recommendations.join("\n"), /Edit-recovery telemetry coverage is incomplete/i);
  assert.match(report.methodology.editRecoveryMetrics, /receipt\/tool_result pair/);
});

test("reports partial injection-item coverage independently from complete receipt coverage", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  appendContextTelemetry(cwd, {
    event: "context_pack_injected",
    sessionId: "session-a",
    taskRunId: "run-a",
    selectedItems: [
      { path: "src/math.ts", estimatedTokens: 20, fileContentHash: "file", payloadHash: "payload", representation: "snippet", ranges: [], generation: 1 },
      { path: "src/service.ts", estimatedTokens: 20 }
    ]
  });

  const report = buildContextEfficiencyReport(cwd);
  assert.deepEqual(report.coverage.injectionReceipts, { status: "complete", observed: 1, comparable: 1, rate: 1 });
  assert.deepEqual(report.coverage.injectionItems, { status: "partial", observed: 2, comparable: 1, rate: 0.5 });
  assert.match(report.recommendations.join("\n"), /Injection item coverage is incomplete/i);
});

test("canonical read input fingerprints ignore object key ordering but preserve array ordering", () => {
  const left = toolResultFingerprint("read", {
    path: "src/math.ts",
    options: { end: 20, start: 1 },
    selectors: [{ name: "calculate", exact: true }, "body"]
  }, []);
  const reordered = toolResultFingerprint("read", {
    selectors: [{ exact: true, name: "calculate" }, "body"],
    options: { start: 1, end: 20 },
    path: "src/math.ts"
  }, []);
  const reversedArray = toolResultFingerprint("read", {
    path: "src/math.ts",
    options: { start: 1, end: 20 },
    selectors: ["body", { exact: true, name: "calculate" }]
  }, []);
  assert.equal(left.inputHash, reordered.inputHash);
  assert.equal(left.key, reordered.key);
  assert.notEqual(left.inputHash, reversedArray.inputHash);
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
  assert.equal(Number(metrics.duplicateInjectionRate.toFixed(4)), 0.3333);
  assert.equal(Number(metrics.duplicateInjectionOccurrenceRate.toFixed(4)), 0.2);
  assert.equal(Number(metrics.duplicateInjectionTokenRate.toFixed(4)), 0.3333);
  assert.equal(Number(metrics.duplicateInjectionObservedTokenRate.toFixed(4)), 0.2308);
  assert.deepEqual(injectionEfficiencyMetrics([]), {
    injectionReceipts: 0, comparableInjectionReceipts: 0, injectionReceiptCoverage: 0,
    injectedPathOccurrences: 0, comparableInjectionItems: 0, injectionItemCoverage: 0, duplicateInjections: 0,
    duplicateInjectionRate: 0, duplicateInjectionOccurrenceRate: 0, macroDuplicateInjectionRate: 0, injectedPathTokens: 0,
    comparableInjectionTokens: 0, duplicateInjectionTokens: 0, duplicateInjectionTokenRate: 0,
    duplicateInjectionObservedTokenRate: 0
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
