import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export function verifyLockedArchive(lock, bytes) {
  assert.match(lock.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`, lock.integrity,
    "offline archive must match package-lock integrity");
}

/** Seed a private cache through npm's public API, then close the loopback source.
 * No external registry download, operator-cache copy, manifest rewrite or sibling install.
 * Only the current pinned leaf runtime dependencies are supported; new dependency
 * shapes must receive explicit fixture support instead of escaping to a registry.
 */
export async function seedOfflinePackageCache(repositoryRoot, directory, cache) {
  fs.mkdirSync(directory, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const archives = Object.entries(manifest.dependencies ?? {}).map(([name, version], index) => {
    assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
    assert.match(version, /^\d+\.\d+\.\d+$/);
    const lock = lockfile.packages[`node_modules/${name}`];
    assert.equal(lock.version, version);
    assert.equal(lock.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
    const report = JSON.parse(execFileSync("npm", ["pack", lock.resolved, "--offline", "--ignore-scripts", "--json", "--pack-destination", directory],
      { cwd: directory, encoding: "utf8", timeout: 20000, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } }))[0];
    assert.equal(report.filename, `${name}-${version}.tgz`);
    const artifact = path.join(directory, report.filename), bytes = fs.readFileSync(artifact);
    verifyLockedArchive(lock, bytes);
    const packageText = execFileSync("tar", ["-xOf", artifact, "package/package.json"], { encoding: "utf8" });
    const dependency = JSON.parse(packageText);
    assert.equal(dependency.name, name); assert.equal(dependency.version, version);
    assert.deepEqual(dependency.dependencies ?? {}, {}, "transitive dependencies need explicit offline fixture support");
    assert.deepEqual(dependency.optionalDependencies ?? {}, {});
    for (const peer of Object.keys(dependency.peerDependencies ?? {})) assert.equal(dependency.peerDependenciesMeta?.[peer]?.optional, true);
    return { name, version, dependency, bytes, integrity: lock.integrity, archivePath: `/archives/${index}.tgz`,
      packageSha256: crypto.createHash("sha256").update(packageText).digest("hex") };
  });
  assert.ok(archives.length > 0, "runtime dependency provisioning must not be vacuous");
  const unexpected = [], requests = [];
  let registry;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const archive = archives.find((item) => request.url === item.archivePath);
    if (request.method === "GET" && archive) {
      response.setHeader("content-type", "application/octet-stream"); response.end(archive.bytes); return;
    }
    const item = archives.find((value) => request.url === `/${value.name}`);
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
  try {
    for (const item of archives) await execute("npm", ["cache", "add", `${item.name}@${item.version}`, "--ignore-scripts",
      "--offline=false", "--registry", registry, "--fetch-retries=0", "--proxy=", "--https-proxy=", "--noproxy=127.0.0.1"], {
      cwd: directory, timeout: 20000, env: { ...process.env, npm_config_cache: cache,
        npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" }
    });
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(unexpected, []);
  for (const item of archives) {
    assert.ok(requests.includes(`/${item.name}`)); assert.ok(requests.includes(item.archivePath));
  }
  assert.equal(server.listening, false, "all actual installs must work after the fixture registry has closed");
  return { registry, dependencies: archives.map(({ name, version, packageSha256 }) => ({ name, version, packageSha256 })) };
}
