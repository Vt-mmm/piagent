import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [workspaceArgument, expectedArgument] = process.argv.slice(2);
const workspace = path.resolve(workspaceArgument);
const expected = Number(expectedArgument);
assert.equal(Number.isSafeInteger(expected) && expected > 0, true);
const root = path.join(workspace, "artifacts", "long-horizon");
const unitRoot = path.join(root, "units");
const files = fs.readdirSync(unitRoot).filter((file) => file.endsWith(".json")).sort();
assert.equal(files.length, expected);
const aggregate = crypto.createHash("sha256");
for (let index = 0; index < files.length; index += 1) {
  const raw = fs.readFileSync(path.join(unitRoot, files[index]));
  const unit = JSON.parse(raw);
  assert.equal(unit.unit, index + 1);
  assert.equal(unit.logicalMinute, index + 1);
  assert.match(unit.sourcePath, /\S/);
  assert.match(unit.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, unit.sourcePath))).digest("hex"), unit.sourceDigest);
  aggregate.update(raw);
}
const report = JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8"));
assert.equal(report.completedUnits, expected);
assert.equal(report.aggregateDigest, aggregate.digest("hex"));
process.stdout.write(`${JSON.stringify({ passed: true, completedUnits: expected, aggregateDigest: report.aggregateDigest })}\n`);
