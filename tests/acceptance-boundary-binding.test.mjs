import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

test("a positive clamp criterion cannot borrow another entrypoint's boundary assertions", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-boundary-binding-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sourcePath = "numeric.mjs", testPath = "numeric.test.mjs";
  fs.writeFileSync(path.join(cwd, sourcePath), "export function count(items, size) { return Math.ceil(items / size); }\n"
    + "export function boundIndex(position, maximum) { return Math.max(1, Math.min(position, maximum)); }\n");
  const criteria = ["`boundIndex` returns zero when no entries exist;", "otherwise it clamps an integer position to the inclusive range `1..maximum`."];
  const built = buildAcceptanceReceipt({ summary: criteria.join(" "), acceptanceCriteria: criteria, source: "runtime" });
  const digest = versionWorkingTreeHash("a".repeat(64)), command = `node --test ${testPath}`;
  const task = { summary: criteria.join(" "), acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
    changeMode: "source-change", changedFiles: [sourcePath, testPath], workingTreeDigestAlgorithm: "wt-content-v2",
    verifyCommands: [command], verifyEvidence: [{ command, observed: true, matchedProfileCommand: true, exitCode: 0,
      preWorkingTreeDigest: digest, workingTreeDigest: digest, recordedAt: "2026-09-06T00:00:00.000Z" }] };
  const refresh = code => {
    fs.writeFileSync(path.join(cwd, testPath), code);
    return refreshAcceptanceReceipt(task, { cwd, currentWorkingTreeDigest: digest }).receipt.criteria[1];
  };
  const imports = "import assert from 'node:assert/strict';\nimport { count, boundIndex } from './numeric.mjs';\n";
  for (const code of [
    imports + "assert.equal(count(11, 5), 3);\n",
    imports + "if (false) assert.equal(boundIndex(-1, 3), 1);\n",
    imports + "assert.equal = () => {}; assert.equal(boundIndex(-1, 3), 1);\n",
    imports + "assert.throws(() => boundIndex('bad', 3), TypeError);\n",
    "import assert from 'node:assert/strict';\nfunction boundIndex() { return 1; }\nassert.equal(boundIndex(-1, 3), 1);\n"
  ]) assert.equal(refresh(code).status, "pending", code);
  assert.equal(refresh(imports + ["-1, 3), 1", "1, 3), 1", "2, 3), 2", "3, 3), 3", "4, 3), 3"]
    .map(args => `assert.equal(boundIndex(${args});`).join("\n")).status, "satisfied");
});
