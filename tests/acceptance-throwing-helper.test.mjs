import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

const M1 = "[M1] `migrationPlan(steps)` requires an array of objects with unique string ids that contain at least one non-whitespace character, callable `apply` functions, and `dependsOn` arrays that contain only known string ids. Reject malformed plans and cycles with `TypeError`.";
const M3 = "[M3] `runMigration({ steps, checkpoint, apply })` requires a planned step array in the exact stable order returned by `migrationPlan`, an async-compatible checkpoint adapter with callable `read()` and `write(completedIds)`, and a callable `apply(step)`. Reject malformed, dependency-unsafe, or unordered step arrays, non-array checkpoint state, and unknown checkpoint ids with `TypeError`.";
const INVALID_PLAN_TESTS = "Preserve exports and add focused crash/resume and invalid-plan tests. Change only the declared source/test scope.";

const planTest = [
  "import assert from 'node:assert/strict';",
  "import { migrationPlan } from '../src/plan.js';",
  "const malformed = [null, {}, [null], [{ id: ' ', dependsOn: [], apply() {} }]];",
  "for (const value of malformed) assert.throws(() => migrationPlan(value), TypeError);",
  ""
].join("\n");

const runnerTest = [
  "import assert from 'node:assert/strict';",
  "import { runMigration } from '../src/runner.js';",
  "const steps = [{ id: 'a', dependsOn: [], apply() {} }];",
  "await assert.rejects(() => runMigration({ steps, checkpoint: null, apply() {} }), TypeError);",
  "await assert.rejects(() => runMigration({ steps, checkpoint: { read: async () => null, write() {} }, apply() {} }), TypeError);",
  ""
].join("\n");

function evidence({ source, testText = planTest, criterion = M1, target = "migrationPlan", sourcePath = "src/plan.js" }) {
  const sourceEntry = { path: sourcePath, text: source };
  const testEntry = { path: "test/migration.test.js", text: testText };
  const namedTargets = target ? [target] : [];
  return acceptanceInvalidInputEvidence({
    taskText: criterion,
    sourceText: source,
    testText,
    sourceEntries: [sourceEntry],
    testEntries: [testEntry],
    namedTargets,
    provenanceTargets: namedTargets
  });
}

describe("acceptance exact throwing-helper evidence", () => {
  it("accepts the retained BR6d M1 and M3 guards through exact local TypeError helpers", () => {
    const planSource = [
      "function invalidPlan() { throw new TypeError('Invalid migration plan'); }",
      "function validateSteps(steps) {",
      "  if (!Array.isArray(steps)) invalidPlan();",
      "  return steps;",
      "}",
      "export function migrationPlan(steps) {",
      "  validateSteps(steps);",
      "  return [...steps];",
      "}",
      ""
    ].join("\n");
    const runnerSource = [
      "import { migrationPlan } from './plan.js';",
      "function invalidMigration() { throw new TypeError('Invalid migration runner input'); }",
      "export async function runMigration({ steps, checkpoint, apply } = {}) {",
      "  if (!Array.isArray(steps) || steps.length !== migrationPlan(steps).length) invalidMigration();",
      "  if (!checkpoint || typeof checkpoint.read !== 'function' || typeof checkpoint.write !== 'function' || typeof apply !== 'function') invalidMigration();",
      "  const state = await checkpoint.read();",
      "  if (!Array.isArray(state)) invalidMigration();",
      "  return { completed: [...state] };",
      "}",
      ""
    ].join("\n");

    assert.deepEqual(evidence({ source: planSource }), { sourceOk: true, testOk: true });
    assert.deepEqual(evidence({
      source: "const invalidPlan = () => { throw new TypeError('Invalid migration plan'); };\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\n"
    }), { sourceOk: true, testOk: true });
    assert.deepEqual(evidence({
      source: runnerSource,
      testText: runnerTest,
      criterion: M3,
      target: "runMigration",
      sourcePath: "src/runner.js"
    }), { sourceOk: true, testOk: true });
  });

  it("binds a generated invalid-plan test obligation to the actually asserted exported entrypoint", () => {
    const source = [
      "function invalidPlan() { throw new TypeError('Invalid migration plan'); }",
      "export function migrationPlan(steps) {",
      "  if (!Array.isArray(steps)) invalidPlan();",
      "  return [...steps];",
      "}",
      ""
    ].join("\n");
    assert.deepEqual(evidence({ source, criterion: INVALID_PLAN_TESTS, target: null }), { sourceOk: true, testOk: true });

    const missingPrimary = "function invalidPlan() { throw new TypeError('Invalid migration plan'); }\nexport { invalidPlan };\n";
    assert.equal(evidence({ source: missingPrimary, criterion: INVALID_PLAN_TESTS, target: null }).testOk, false);
  });

  it("rejects helpers with conditional, caught, nonthrowing, wrong-error, side-effect, alias, or reassignment shapes", () => {
    const variants = [
      "function invalidPlan() { if (globalThis.flag) throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) { try { invalidPlan(); } catch {} } return steps; }",
      "function invalidPlan() { return new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new RangeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function audit() {}\nfunction invalidPlan() { audit(); throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function TypeError() {}\nfunction invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "async function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nconst alias = invalidPlan;\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\ninvalidPlan = () => { throw new TypeError('decoy'); };\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nglobalThis.TypeError = RangeError;\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (globalThis.flag && !Array.isArray(steps)) invalidPlan(); return steps; }",
      "if (false) { function invalidPlan() { throw new TypeError('bad'); } }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function outer() { function invalidPlan() { throw new TypeError('bad'); } }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "import { invalidPlan } from './decoy.js';\nfunction invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function enabled() { return false; }\nfunction invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps) && enabled()) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps, invalidPlan) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nprocess.exit(0);\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\n({ invalidPlan } = { invalidPlan() {} });\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\n[invalidPlan] = [() => {}];\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nfor ({ invalidPlan } of [{ invalidPlan() {} }]) {}\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\nmigrationPlan = () => [];",
      "function invalidPlan() { throw new TypeError('bad'); }\nglobalThis['TypeError'] = RangeError;\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }",
      "function invalidPlan() { throw new TypeError('bad'); }\nObject.defineProperty(globalThis, 'TypeError', { value: RangeError });\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }"
      ,"function invalidPlan() { throw new TypeError('bad'); }\nType\\u0045rror = RangeError;\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }"
      ,"function invalidPlan() { throw new TypeError('bad'); }\ninv\\u0061lidPlan = () => {};\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }"
      ,"function invalidPlan() { throw new TypeError('bad'); }\nconst root = Function('return this')(); root.TypeError = RangeError;\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }"
    ];
    for (const source of variants) {
      assert.equal(evidence({ source }).sourceOk, false, source);
    }
  });

  it("rejects test-side constructor mutation and unexported no-target decoys", () => {
    assert.equal(process.getBuiltinModule("node:assert/strict"), assert, "Node exposes one cached assert singleton through both APIs");
    const source = "function invalidPlan() { throw new TypeError('bad'); }\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\n";
    const mutations = [
      "globalThis['TypeError'] = RangeError;",
      "Object.defineProperty(globalThis, 'TypeError', { value: RangeError });",
      "Reflect.set(globalThis, 'TypeError', RangeError);",
      "Object.assign(globalThis, { TypeError: RangeError });",
      "({ TypeError } = { TypeError: RangeError });"
    ];
    for (const mutation of mutations) {
      assert.equal(evidence({ source, testText: `${mutation}\n${planTest}` }).testOk, false, mutation);
    }

    const assertionMutations = [
      "assert.throws = () => {};",
      "assert['throws'] = () => {};",
      "const key = 'throws'; assert[key] = () => {};",
      "Object.defineProperty(assert, 'throws', { value: () => {} });",
      "Object.assign(assert, { throws() {} });",
      "const alias = assert; alias.throws = () => {};",
      "const box = [assert]; box[0].throws = () => {};",
      "const alias = (assert); alias.throws = () => {};",
      "let alias; [alias] = [assert]; alias.throws = () => {};",
      "let alias; ({ a: alias } = { a: assert }); alias.throws = () => {};",
      "import poison from 'node:assert/strict'; poison.throws = () => {};",
      "const poison = process.getBuiltinModule('node:assert/strict'); poison.throws = () => {};",
      "import { createRequire } from 'node:module'; const loader = createRequire(import.meta.url); loader('node:assert/strict').throws = () => {};",
      "eval(\"require('node:assert/strict').throws = () => {}\");",
      "const root = Function('return this')(); root.TypeError = RangeError;",
      "glob\\u0061lThis.TypeError = RangeError;",
      "import vm from 'node:vm'; vm.runInThisContext('TypeError = RangeError');"
    ];
    for (const mutation of assertionMutations) {
      const mutatedTest = planTest.replace("const malformed", `${mutation}\nconst malformed`);
      assert.equal(evidence({ source, testText: mutatedTest }).testOk, false, mutation);
    }
    const cjsSource = "function invalidPlan() { throw new TypeError('bad'); }\nfunction migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\nmodule.exports = { migrationPlan };\n";
    const cjsPoison = "const assert = require('node:assert/strict');\nconst poison = require('node:assert/strict');\nconst { migrationPlan } = require('../src/plan.js');\npoison.throws = () => {};\nassert.throws(() => migrationPlan(null), TypeError);\n";
    assert.equal(evidence({ source: cjsSource, testText: cjsPoison }).testOk, false);

    const reboundSource = "function invalidPlan() { throw new TypeError('bad'); }\nfor ({ invalidPlan } of [{ invalidPlan() {} }]) {}\nexport function migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\n";
    const forgedTest = planTest.replace("const malformed", "assert.throws = () => {};\nconst malformed");
    assert.deepEqual(evidence({ source: reboundSource, testText: forgedTest }), { sourceOk: false, testOk: false });

    const unexported = "function invalidPlan() { throw new TypeError('bad'); }\nfunction migrationPlan(steps) { if (!Array.isArray(steps)) invalidPlan(); return steps; }\n";
    assert.deepEqual(evidence({ source: unexported, criterion: INVALID_PLAN_TESTS, target: null }), { sourceOk: false, testOk: false });
  });
});
