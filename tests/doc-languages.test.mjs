import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { inspectDocLanguages, markdownRelativeLink } from "../scripts/check-doc-languages.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("documentation languages", () => {
  it("builds portable reciprocal links", () => {
    assert.equal(
      markdownRelativeLink(
        path.join(repoRoot, "docs", "en", "architecture.md"),
        path.join(repoRoot, "docs", "vi", "architecture.md")
      ),
      "../vi/architecture.md"
    );
  });

  it("keeps every canonical maintainer topic paired in EN and VI", () => {
    const result = inspectDocLanguages(repoRoot);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.ok(result.pairs >= 4);
    assert.ok(result.terms.includes("MCP"));
  });

  it("rejects a manifest whose Vietnamese peer is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-doc-languages-"));
    temporaryRoots.add(root);
    fs.mkdirSync(path.join(root, "docs", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "en", "topic.md"), "# Topic\n\n[Tiếng Việt](../vi/topic.md)\n");
    fs.writeFileSync(path.join(root, "docs", "languages.json"), JSON.stringify({
      schemaVersion: 1,
      pairs: [{ topic: "topic", en: "docs/en/topic.md", vi: "docs/vi/topic.md" }]
    }));

    const result = inspectDocLanguages(root);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ["topic: missing Vietnamese file docs/vi/topic.md"]);
  });
});
