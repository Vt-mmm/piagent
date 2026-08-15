import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("WUI5-18 has an executable acceptance case for every release boundary", () => {
  const file = path.join(root, "governance", "piagent-webui", "wui5-18-acceptance-matrix.v1.json");
  const matrix = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.milestone, "WUI5-18");
  assert.ok(matrix.cases.length >= 19);
  const ids = new Set();
  for (const item of matrix.cases) {
    assert.match(item.id, /^[a-z0-9][a-z0-9-]{2,79}$/);
    assert.equal(ids.has(item.id), false, `duplicate acceptance case ${item.id}`); ids.add(item.id);
    const target = path.join(root, item.testFile);
    assert.equal(fs.existsSync(target), true, `missing ${item.testFile}`);
    assert.equal(fs.readFileSync(target, "utf8").toLowerCase().includes(item.testName.toLowerCase()), true,
      `${item.id} is not bound to an executable test name`);
  }
});
