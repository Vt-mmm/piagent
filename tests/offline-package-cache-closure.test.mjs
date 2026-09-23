import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { lockedRuntimeDependencies, seedOfflinePackageCache } from "./helpers/offline-package-cache.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readManifest = () => JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const readLock = () => JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));

test("the scoped lock closure includes real transitive declarations and canonical archive names", () => {
  const entries = lockedRuntimeDependencies(readManifest(), readLock());
  assert.equal(new Set(entries.map(entry => entry.name)).size, 5);
  assert.equal(entries.length, 5);
  const parser = entries.find(entry => entry.name === "@babel/parser");
  assert.equal(parser.filename, "babel-parser-7.29.8.tgz");
  assert.equal(parser.lock.resolved, "https://registry.npmjs.org/@babel/parser/-/parser-7.29.8.tgz");
  assert.deepEqual(parser.lock.dependencies, { "@babel/types": "^7.29.8" });
  assert.equal(entries.find(entry => entry.name === "ws").filename, "ws-8.21.3.tgz");
});

for (const [name, change, expected] of [
  ["missing transitive package", lock => { delete lock.packages["node_modules/@babel/types"]; }, /missing locked runtime dependency/],
  ["unsatisfied transitive range", lock => { lock.packages["node_modules/@babel/parser"].dependencies["@babel/types"] = "^8.0.0"; }, /does not satisfy/],
  ["unsupported dependency source", lock => { lock.packages["node_modules/@babel/types"].resolved = "https://example.invalid/types.tgz"; }, /Expected values to be strictly equal/],
  ["nested resolution", lock => { lock.packages["node_modules/@babel/parser/node_modules/@babel/types"] = lock.packages["node_modules/@babel/types"]; }, /nested dependencies/],
  ["linked resolution", lock => { lock.packages["node_modules/@babel/types"].link = true; }, /linked dependencies/],
  ["required peer", lock => { lock.packages["node_modules/@babel/types"].peerDependencies = { missing: "1.0.0" }; }, /required peers/],
  ["optional dependency", lock => { lock.packages["node_modules/@babel/types"].optionalDependencies = { missing: "1.0.0" }; }, /optional dependencies/],
  ["unbound range shape", lock => { lock.packages["node_modules/@babel/parser"].dependencies["@babel/types"] = "latest"; }, /unsupported offline dependency range/]
]) test(`unsupported closure fails before provisioning: ${name}`, () => {
  const lock = readLock(); change(lock);
  assert.throws(() => lockedRuntimeDependencies(readManifest(), lock), expected);
});

test("runtime roots must stay exactly pinned and agree with package-lock", () => {
  const manifest = readManifest(), lock = readLock();
  manifest.dependencies["@babel/parser"] = "^7.29.8";
  assert.throws(() => lockedRuntimeDependencies(manifest, lock), /must match package-lock/);
  lock.packages[""].dependencies["@babel/parser"] = "^7.29.8";
  assert.throws(() => lockedRuntimeDependencies(manifest, lock), /must be pinned/);
});

test("scoped runtime packages and their locked closure install from an isolated cache after its registry closes", async t => {
  // npm must receive the same canonical prefix as its real cwd, including on
  // macOS where /var and /private/var otherwise produce different lock paths.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-offline-closure-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache"), install = path.join(root, "install");
  const manifest = readManifest(), lock = readLock();
  const offline = await seedOfflinePackageCache(repositoryRoot, path.join(root, "archives"), cache);
  assert.deepEqual(offline.dependencies.map(({ name, version }) => [name, version]).sort(), [
    ["@babel/helper-string-parser", "7.29.7"], ["@babel/helper-validator-identifier", "7.29.7"],
    ["@babel/parser", "7.29.8"], ["@babel/types", "7.29.8"], ["ws", "8.21.3"]
  ]);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = http.get(offline.registry, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  }), { code: "ECONNREFUSED" });
  fs.mkdirSync(install);
  const env = { ...process.env, npm_config_cache: cache, npm_config_audit: "false", npm_config_fund: "false",
    npm_config_update_notifier: "false" };
  delete env.NODE_PATH;
  const installOutput = execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "--registry", offline.registry, "--prefix", install,
    ...Object.entries(manifest.dependencies).map(([name, version]) => `${name}@${version}`)],
  { cwd: install, env, encoding: "utf8", timeout: 30000 });
  const installedLock = JSON.parse(fs.readFileSync(path.join(install, "package-lock.json"), "utf8"));
  for (const dependency of offline.dependencies) {
    const packageText = fs.readFileSync(path.join(install, "node_modules", dependency.name, "package.json"));
    const actual = JSON.parse(packageText), pinned = lock.packages[`node_modules/${dependency.name}`];
    assert.equal(actual.name, dependency.name);
    assert.equal(actual.version, pinned.version);
    assert.deepEqual(actual.dependencies ?? {}, pinned.dependencies ?? {});
    assert.equal(crypto.createHash("sha256").update(packageText).digest("hex"), dependency.packageSha256);
    const installedEntry = installedLock.packages[`node_modules/${dependency.name}`];
    assert.ok(installedEntry, JSON.stringify({ dependency: dependency.name, installOutput,
      observedLockPaths: Object.keys(installedLock.packages) }));
    assert.equal(installedEntry.integrity, pinned.integrity);
  }
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    "import { parse } from '@babel/parser'; import { isIdentifier } from '@babel/types'; "
      + "console.log(JSON.stringify({ kind: parse('export function check(value) { return value; }', { sourceType: 'module' }).program.body[0].type, "
      + "identifier: isIdentifier({ type: 'Identifier', name: 'check' }) }));"],
  { cwd: install, env, encoding: "utf8", timeout: 10000 });
  assert.deepEqual(JSON.parse(output), { kind: "ExportNamedDeclaration", identifier: true });
});
