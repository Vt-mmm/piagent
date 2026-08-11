import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectArchitecture,
  layerFor,
  readConfig,
  sourceLineCount
} from "../scripts/check-architecture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = readConfig();
const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("architecture boundaries", () => {
  it("assigns composition before the broader legacy core root", () => {
    assert.equal(layerFor("packages/piagent-core/extensions/piagent-guard.ts", config), "composition");
    assert.equal(layerFor("packages/piagent-core/extensions/policy-core.js", config), "core");
    assert.equal(layerFor("packages/piagent-core/runtime/session/usage.ts", config), "runtime");
  });

  it("counts source lines without charging the final newline", () => {
    assert.equal(sourceLineCount("a\nb\n"), 2);
    assert.equal(sourceLineCount("a\nb"), 2);
    assert.equal(sourceLineCount(""), 0);
  });

  it("keeps the repository inside declared dependency and size boundaries", () => {
    const result = inspectArchitecture({ root: repoRoot, config });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.layers.runtime >= 4);
  });

  it("keeps the composition exception bounded, dated, and assigned to an extraction work item", () => {
    const exception = config.budgetExceptions.find((item) => item.file === "packages/piagent-core/extensions/piagent-guard.ts");
    assert.equal(exception.approvedMaximum, config.lineBudgets.files[exception.file]);
    assert.ok(exception.targetMaximum <= 5000);
    assert.match(exception.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(exception.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(exception.expiresOn) > Date.parse(exception.reviewedAt));
    assert.equal(exception.ownerWorkItem, "CF-P4-03-prep");
    const guard = fs.readFileSync(path.join(repoRoot, exception.file), "utf8");
    assert.ok(sourceLineCount(guard) <= exception.targetMaximum);
  });

  it("rejects a runtime import back into composition and a new oversized module", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-architecture-"));
    temporaryRoots.add(root);
    const runtimeDir = path.join(root, "packages", "piagent-core", "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "bad.ts"),
      `import guard from "../extensions/piagent-guard.ts";\n${"const value = 1;\n".repeat(501)}void guard;\n`
    );

    const result = inspectArchitecture({ root, config });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /runtime cannot import composition/.test(error)), result.errors.join("\n"));
    assert.ok(result.errors.some((error) => /exceeds the runtime budget of 500/.test(error)), result.errors.join("\n"));
  });
});
