import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^\d+\.\d+\.\d+$/;

function acceptsLockedVersion(specifier, version) {
  assert.match(specifier, /^\^?\d+\.\d+\.\d+$/, "unsupported offline dependency range");
  if (!specifier.startsWith("^")) return specifier === version;
  const minimum = specifier.slice(1).split(".").map(Number), actual = version.split(".").map(Number);
  const stablePart = minimum[0] !== 0 ? 0 : minimum[1] !== 0 ? 1 : 2;
  if (!minimum.slice(0, stablePart + 1).every((part, index) => actual[index] === part)) return false;
  for (let index = stablePart + 1; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

/** The fixture supports a flat, exact lock closure, not dependency discovery.
 * Unsupported optional, required-peer, nested, linked or non-registry shapes
 * fail before npm is invoked; no missing package can escape to a registry.
 */
export function lockedRuntimeDependencies(manifest, lockfile) {
  assert.deepEqual(lockfile.packages?.[""]?.dependencies ?? {}, manifest.dependencies ?? {},
    "root runtime dependencies must match package-lock");
  const closure = new Map();
  const visit = (name, specifier, direct = false) => {
    assert.match(name, packageName);
    if (direct) assert.match(specifier, exactVersion, "root runtime dependencies must be pinned");
    const key = `node_modules/${name}`, lock = lockfile.packages[key];
    assert.ok(lock, `missing locked runtime dependency: ${name}`);
    assert.notEqual(lock.link, true, "linked dependencies need explicit offline fixture support");
    assert.match(lock.version, exactVersion);
    assert.ok(acceptsLockedVersion(specifier, lock.version), `locked version does not satisfy ${name}@${specifier}`);
    const basename = name.split("/").at(-1), version = lock.version;
    assert.equal(lock.resolved, `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`);
    assert.deepEqual(lock.optionalDependencies ?? {}, {}, "optional dependencies need explicit offline fixture support");
    for (const peer of Object.keys(lock.peerDependencies ?? {})) {
      assert.equal(lock.peerDependenciesMeta?.[peer]?.optional, true, "required peers need explicit offline fixture support");
    }
    if (closure.has(name)) return;
    closure.set(name, { name, version, lock, filename: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz` });
    for (const [child, range] of Object.entries(lock.dependencies ?? {})) {
      assert.match(child, packageName);
      assert.equal(lockfile.packages[`${key}/node_modules/${child}`], undefined,
        "nested dependencies need explicit offline fixture support");
      visit(child, range);
    }
  };
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) visit(name, version, true);
  assert.ok(closure.size > 0, "runtime dependency provisioning must not be vacuous");
  return [...closure.values()];
}

export function verifyLockedArchive(lock, bytes) {
  assert.match(lock.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`, lock.integrity,
    "offline archive must match package-lock integrity");
}

/** Seed a private cache through npm's public API, then close the loopback source.
 * No external registry download, operator-cache copy, manifest rewrite or sibling install.
 * Scoped packages and the complete flat lock closure retain their real metadata.
 * Original archives come from npm's offline public API and must match the lock;
 * installed package directories are never repacked into substitute archives.
 */
export async function seedOfflinePackageCache(repositoryRoot, directory, cache) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const archives = lockedRuntimeDependencies(manifest, lockfile).map(({ name, version, lock, filename }, index) => {
    const report = JSON.parse(execFileSync("npm", ["pack", lock.resolved, "--offline", "--ignore-scripts", "--json", "--pack-destination", directory],
      { cwd: directory, encoding: "utf8", timeout: 20000, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } }))[0];
    assert.equal(report.filename, filename);
    const artifact = path.join(directory, report.filename), bytes = fs.readFileSync(artifact);
    verifyLockedArchive(lock, bytes);
    const packageText = execFileSync("tar", ["-xOf", artifact, "package/package.json"], { encoding: "utf8" });
    const dependency = JSON.parse(packageText);
    assert.equal(dependency.name, name); assert.equal(dependency.version, version);
    assert.deepEqual(dependency.dependencies ?? {}, lock.dependencies ?? {}, "archive dependencies must match package-lock");
    assert.deepEqual(dependency.optionalDependencies ?? {}, {});
    for (const peer of Object.keys(dependency.peerDependencies ?? {})) assert.equal(dependency.peerDependenciesMeta?.[peer]?.optional, true);
    return { name, version, dependency, bytes, integrity: lock.integrity, archivePath: `/archives/${index}.tgz`,
      packageSha256: crypto.createHash("sha256").update(packageText).digest("hex") };
  });
  assert.ok(archives.length > 0, "runtime dependency provisioning must not be vacuous");
  const unexpected = [], requests = [];
  const decodedPath = value => { try { return decodeURIComponent(value); } catch { return null; } };
  let registry;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const archive = archives.find((item) => request.url === item.archivePath);
    if (request.method === "GET" && archive) {
      response.setHeader("content-type", "application/octet-stream"); response.end(archive.bytes); return;
    }
    const item = archives.find((value) => decodedPath(request.url) === `/${value.name}`);
    if (request.method === "GET" && item) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: item.name, "dist-tags": { latest: item.version }, versions: {
        [item.version]: { ...item.dependency, dist: { tarball: `${registry}${item.archivePath.slice(1)}`, integrity: item.integrity } }
      } })); return;
    }
    unexpected.push(`${request.method} ${request.url}`); response.statusCode = 404; response.end("{}");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  registry = `http://127.0.0.1:${server.address().port}/`;
  const fixtureEnv = { ...process.env };
  for (const key of Object.keys(fixtureEnv)) if (/^npm_config_/i.test(key)) delete fixtureEnv[key];
  Object.assign(fixtureEnv, { npm_config_cache: cache, npm_config_audit: "false", npm_config_fund: "false",
    npm_config_update_notifier: "false", npm_config_userconfig: path.join(directory, "no-user.npmrc"),
    npm_config_globalconfig: path.join(directory, "no-global.npmrc") });
  try {
    for (const item of archives) await execute("npm", ["cache", "add", `${item.name}@${item.version}`, "--ignore-scripts",
      "--offline=false", "--registry", registry, "--fetch-retries=0", "--proxy=", "--https-proxy=", "--noproxy=127.0.0.1"], {
      cwd: directory, timeout: 20000, env: fixtureEnv
    });
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(unexpected, []);
  for (const item of archives) {
    assert.ok(requests.some(value => decodedPath(value) === `/${item.name}`)); assert.ok(requests.includes(item.archivePath));
  }
  assert.equal(server.listening, false, "all actual installs must work after the fixture registry has closed");
  return { registry, dependencies: archives.map(({ name, version, packageSha256 }) => ({ name, version, packageSha256 })) };
}
