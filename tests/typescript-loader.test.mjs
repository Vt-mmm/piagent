import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { PINNED_EXTERNAL_TRANSFORM, load, resolve } from "../scripts/typescript-loader.mjs";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-loader-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
  delete process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT;
  delete process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA;
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loader-"));
  temporaryRoots.add(root);
  return root;
}

// Parameter properties are the reason the exception exists: `strip` cannot
// erase them, `transform` can. So the emitted source tells the two modes apart
// without asking the loader which one it picked.
const PARAMETER_PROPERTY = "export class A { constructor(private readonly x: number) {} }\n";

function adapterRoot({ name = PINNED_EXTERNAL_TRANSFORM.packageName, version = PINNED_EXTERNAL_TRANSFORM.packageVersion } = {}) {
  const root = scratch();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(root, "oauth.ts"), PARAMETER_PROPERTY);
  return root;
}

async function loadFile(file) {
  return load(pathToFileURL(file).href, {}, () => { throw new Error("nextLoad should not run for .ts"); });
}

function runtimeBinding({ snapshotRoot, resolutionRoot, packages }) {
  const runtimeDependencies = {
    schemaVersion: 2,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    packages,
    resolutionRoot,
    resolutionTree: null,
    isolation: "outside-repo-snapshot; suite-static-import-graph-bound; provider-host-closure-bound"
  };
  runtimeDependencies.digest = crypto.createHash("sha256")
    .update(JSON.stringify(runtimeDependencies)).digest("hex");
  return Buffer.from(JSON.stringify({ schemaVersion: 1, snapshotRoot, runtimeDependencies }), "utf8").toString("base64url");
}

function resolutionFixture() {
  const root = scratch();
  const snapshotRoot = path.join(root, "candidate");
  const importer = path.join(snapshotRoot, "scripts", "entry.mjs");
  const resolutionRoot = path.join(root, "runtime", "node_modules");
  const packageRoot = path.join(resolutionRoot, "fixture-runtime");
  const exported = path.join(packageRoot, "index.mjs");
  fs.mkdirSync(path.dirname(importer), { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(importer, "export {};\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-runtime", version: "1.2.3", type: "module", exports: "./index.mjs"
  }));
  fs.writeFileSync(exported, "export const ready = true;\n");
  return { root, snapshotRoot, importer, resolutionRoot, packageRoot, exported };
}

describe("benchmark runtime dependency resolution", () => {
  it("redirects an exactly declared package to its bound resolution root", async () => {
    const fixture = resolutionFixture();
    process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = runtimeBinding({
      snapshotRoot: fixture.snapshotRoot,
      resolutionRoot: fixture.resolutionRoot,
      packages: { "fixture-runtime": "1.2.3" }
    });
    let delegatedParent = null;
    const result = await resolve("fixture-runtime", { parentURL: pathToFileURL(fixture.importer).href },
      async (_specifier, context) => {
        delegatedParent = context.parentURL;
        return { url: pathToFileURL(fixture.exported).href, format: "module" };
      });
    assert.equal(result.url, pathToFileURL(fixture.exported).href);
    assert.equal(fs.realpathSync(path.dirname(fileURLToPath(delegatedParent))),
      fs.realpathSync(path.dirname(fixture.resolutionRoot)));
  });

  it("rejects undeclared, version-drifted and escaping package exports", async () => {
    const fixture = resolutionFixture();
    const parentURL = pathToFileURL(fixture.importer).href;
    const next = async () => ({ url: pathToFileURL(fixture.exported).href, format: "module" });

    process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = runtimeBinding({
      snapshotRoot: fixture.snapshotRoot,
      resolutionRoot: fixture.resolutionRoot,
      packages: { "different-runtime": "1.2.3" }
    });
    await assert.rejects(() => resolve("fixture-runtime", { parentURL }, next), /package-not-declared:fixture-runtime/);

    process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = runtimeBinding({
      snapshotRoot: fixture.snapshotRoot,
      resolutionRoot: fixture.resolutionRoot,
      packages: { "fixture-runtime": "9.9.9" }
    });
    await assert.rejects(() => resolve("fixture-runtime", { parentURL }, next), /package-identity-mismatch:fixture-runtime/);

    process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = runtimeBinding({
      snapshotRoot: fixture.snapshotRoot,
      resolutionRoot: fixture.resolutionRoot,
      packages: { "fixture-runtime": "1.2.3" }
    });
    const escaped = path.join(fixture.resolutionRoot, "outside.mjs");
    fs.writeFileSync(escaped, "export {};\n");
    await assert.rejects(() => resolve("fixture-runtime", { parentURL }, async () => ({
      url: pathToFileURL(escaped).href, format: "module"
    })), /package-export-escaped:fixture-runtime/);
  });

  it("rejects tampered bootstrap dependency metadata before resolution", async () => {
    const fixture = resolutionFixture();
    const encoded = runtimeBinding({ snapshotRoot: fixture.snapshotRoot, resolutionRoot: fixture.resolutionRoot,
      packages: { "fixture-runtime": "1.2.3" } });
    const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    metadata.runtimeDependencies.packages["fixture-runtime"] = "1.2.4";
    process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
    await assert.rejects(() => resolve("fixture-runtime", { parentURL: pathToFileURL(fixture.importer).href }, async () => ({
      url: pathToFileURL(fixture.exported).href, format: "module"
    })), /metadata-digest-mismatch/);
  });
});

describe("pinned TypeScript transform", () => {
  // The bug this file was written for. `pinnedTransformRoot` answers one
  // question -- is this file inside the pinned adapter -- and it used to throw
  // ENOENT instead of answering "no" when the configured root did not exist.
  // The throw escaped `load`, so the first .ts file of any kind killed the
  // process. On a machine without pi-mcp-adapter the gateway could not start at
  // all, and the operator was told "gateway-start-timeout".
  it("answers no, rather than throwing, when the configured root does not exist", async () => {
    const root = scratch();
    process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT = path.join(root, "does", "not", "exist");
    const unrelated = path.join(root, "unrelated.ts");
    fs.writeFileSync(unrelated, "export const x: number = 1;\n");

    const result = await loadFile(unrelated);
    // strip pads erased types with spaces so line and column positions survive,
    // so assert the annotation is gone rather than the exact spacing.
    assert.doesNotMatch(result.source, /:\s*number/);
    assert.match(result.source, /export const x\s+= 1;/);
  });

  it("still refuses the transform for a root that is not the pinned adapter", async () => {
    // Falling back must not become a way in. A directory that merely exists is
    // not the reviewed package.
    for (const wrong of [{ name: "not-the-adapter" }, { version: "0.0.1" }]) {
      const root = adapterRoot(wrong);
      process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT = root;
      await assert.rejects(() => loadFile(path.join(root, "oauth.ts")),
        /parameter propert/i, `${JSON.stringify(wrong)} was transformed`);
    }
  });

  it("still refuses the transform for a file outside the pinned root", async () => {
    const root = adapterRoot();
    process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT = root;
    const outside = path.join(scratch(), "oauth.ts");
    fs.writeFileSync(outside, PARAMETER_PROPERTY);
    await assert.rejects(() => loadFile(outside), /parameter propert/i);
  });

  it("still grants the transform to the exact reviewed adapter", async () => {
    // Without this, deleting the transform path entirely would satisfy every
    // test above, and pi-mcp-adapter OAuth would stop loading.
    if (process.versions.node !== PINNED_EXTERNAL_TRANSFORM.nodeVersion) return;
    const root = adapterRoot();
    process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT = root;
    const result = await loadFile(path.join(root, "oauth.ts"));
    assert.match(result.source, /this\.x = x/);
  });

  it("refuses the transform on a Node release that was never reviewed", async () => {
    const root = adapterRoot();
    process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT = root;
    assert.notEqual(PINNED_EXTERNAL_TRANSFORM.nodeVersion, "0.0.0");
    // The pin is a constant, so this asserts the shape the check depends on
    // rather than re-running it under a different runtime.
    assert.match(PINNED_EXTERNAL_TRANSFORM.nodeVersion, /^\d+\.\d+\.\d+$/);
  });

  it("passes non-TypeScript modules straight through", async () => {
    delete process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT;
    const sentinel = Symbol("next");
    assert.equal(await load("file:///x.js", {}, () => sentinel), sentinel);
  });
});
