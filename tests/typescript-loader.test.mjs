import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { PINNED_EXTERNAL_TRANSFORM, load } from "../scripts/typescript-loader.mjs";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-loader-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
  delete process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT;
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
