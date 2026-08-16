import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { contentDigest, inspectPairing } from "../scripts/verify-translation-pairing.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "verify-translation-pairing.mjs");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-pairing-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(pairs, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pairing-"));
  temporaryRoots.add(root);
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  return { root, manifest: { pairs } };
}

describe("bilingual pairing record", () => {
  const files = { "en/a.md": "english\n", "vi/a.md": "tiếng việt\n" };
  const paired = (overrides = {}) => [{
    topic: "a", en: "en/a.md", vi: "vi/a.md",
    consistentAt: { en: contentDigest(files["en/a.md"]), vi: contentDigest(files["vi/a.md"]) },
    ...overrides
  }];

  it("passes when neither side has moved", () => {
    const { root, manifest } = fixture(paired(), files);
    const result = inspectPairing({ root, manifest });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 1);
  });

  // The failure this exists for. The existing language gate only proves the
  // peer file exists, so editing one side and forgetting the other passes
  // everything and leaves a reader with a document describing the old design.
  it("fails when one side moved and the other did not, and names both", () => {
    const { root, manifest } = fixture(paired(), files);
    fs.writeFileSync(path.join(root, "en/a.md"), "english, revised\n");

    const result = inspectPairing({ root, manifest });
    assert.equal(result.ok, false);
    assert.deepEqual(result.drifted.map((entry) => entry.topic), ["a"]);
    assert.deepEqual(result.drifted[0].moved, ["en"]);
    assert.deepEqual(result.stale, []);
  });

  it("reports a two-sided edit differently, because it is a different problem", () => {
    // Both sides moving is probably a paired edit, but nothing here can prove
    // it. Calling it drift would cry wolf; calling it fine would make the record
    // meaningless. It is reported as needing re-confirmation.
    const { root, manifest } = fixture(paired(), files);
    fs.writeFileSync(path.join(root, "en/a.md"), "english, revised\n");
    fs.writeFileSync(path.join(root, "vi/a.md"), "tiếng việt, đã sửa\n");

    const result = inspectPairing({ root, manifest });
    assert.equal(result.ok, false);
    assert.deepEqual(result.stale.map((entry) => entry.topic), ["a"]);
    assert.deepEqual(result.drifted, []);
  });

  it("refuses a pair that has never been recorded", () => {
    const { root, manifest } = fixture(paired({ consistentAt: undefined }), files);
    const result = inspectPairing({ root, manifest });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unrecorded, ["a"]);
  });

  it("reports a missing side instead of silently skipping it", () => {
    const { root, manifest } = fixture(paired(), { "en/a.md": files["en/a.md"] });
    const result = inspectPairing({ root, manifest });
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0], /vi\/a\.md does not exist/);
  });

  it("does not read a line-ending difference as drift", () => {
    // A Windows checkout would otherwise report every pair as drifted, and a
    // gate that is wrong every time is a gate people learn to skip.
    const { root, manifest } = fixture(paired(), files);
    fs.writeFileSync(path.join(root, "en/a.md"), "english\r\n");
    assert.equal(inspectPairing({ root, manifest }).ok, true);
  });
});

describe("bilingual pairing in this repository", () => {
  it("has every pair recorded and matching right now", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /PASS: \d+ bilingual pairs match/);
  });

  it("records a digest for every pair the language manifest declares", () => {
    // A pair added to languages.json without a record would be checked by the
    // older gate and skipped by this one, which is the gap it was written for.
    const languages = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "docs/languages.json"), "utf8"));
    assert.ok(languages.pairs.length >= 4);
    for (const pair of languages.pairs) {
      assert.ok(pair.consistentAt?.en, `${pair.topic} has no recorded English digest`);
      assert.ok(pair.consistentAt?.vi, `${pair.topic} has no recorded Vietnamese digest`);
    }
  });

  it("is wired into the verification gate, not only runnable by hand", () => {
    const gate = fs.readFileSync(path.join(repositoryRoot, "scripts/verify-local.sh"), "utf8");
    assert.match(gate, /node "\$ROOT\/scripts\/verify-translation-pairing\.mjs"/);
  });
});
