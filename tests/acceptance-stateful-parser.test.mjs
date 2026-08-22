import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

const criterion = "`parseRecord(input)` must throw `SyntaxError` for an unterminated quoted field.";
const focusedTest = [
  "import assert from 'node:assert/strict';",
  "import { parseRecord } from '../src/parser.js';",
  "assert.throws(() => parseRecord('\\\"unterminated'), SyntaxError);",
  ""
].join("\n");

function evidence(source, testText = focusedTest, taskText = criterion) {
  const sourceEntry = { path: "src/parser.js", text: source };
  const testEntry = { path: "test/parser.test.js", text: testText };
  return acceptanceInvalidInputEvidence({
    taskText,
    sourceText: source,
    testText,
    sourceEntries: [sourceEntry],
    testEntries: [testEntry],
    namedTargets: ["parseRecord"],
    provenanceTargets: ["parseRecord"]
  });
}

const validParser = [
  "export function parseRecord(input) {",
  "  const text = String(input);",
  "  let inQuotes = false;",
  "  for (let index = 0; index < text.length; index += 1) {",
  "    if (inQuotes) {",
  "      if (text[index] === '\"') inQuotes = false;",
  "      continue;",
  "    }",
  "    if (text[index] === '\"') inQuotes = true;",
  "  }",
  "  if (inQuotes) throw new SyntaxError('unterminated');",
  "  return [];",
  "}",
  ""
].join("\n");

const historicalCsvShape = [
  "export function parseRecord(input) {",
  "  const text = String(input);",
  "  let field = '';",
  "  let inQuotes = false;",
  "  let closedQuote = false;",
  "  for (let index = 0; index < text.length; index += 1) {",
  "    const character = text[index];",
  "    if (inQuotes) {",
  "      if (character === '\"') {",
  "        if (text[index + 1] === '\"') index += 1;",
  "        else { inQuotes = false; closedQuote = true; }",
  "      } else field += character;",
  "      continue;",
  "    }",
  "    if (character === '\"' && field === '') inQuotes = true;",
  "    else if (!closedQuote) field += character;",
  "  }",
  "  if (inQuotes) throw new SyntaxError('unterminated');",
  "  return [field];",
  "}",
  ""
].join("\n");

function parserWithLoop(lines, options = {}) {
  return [
    "export function parseRecord(input) {",
    "  const text = String(input);",
    options.declaration ?? "  let inQuotes = false;",
    `  ${options.header ?? "for (let index = 0; index < text.length; index += 1)"} {`,
    ...lines.map((line) => `    ${line}`),
    "  }",
    "  if (inQuotes) throw new SyntaxError('unterminated');",
    "  return [];",
    "}",
    ""
  ].join("\n");
}

describe("stateful terminal parser rejection evidence", () => {
  it("accepts an input-derived local state machine with a live named SyntaxError assertion", () => {
    assert.deepEqual(evidence(validParser), { sourceOk: true, testOk: true });
    assert.deepEqual(evidence(historicalCsvShape), { sourceOk: true, testOk: true });
    assert.equal(evidence(validParser, focusedTest.replace("parseRecord('\\\"unterminated')", "String(Symbol())")).testOk, false);
  });

  it("rejects out-of-loop state, missing transitions, unrelated loops, callbacks, shadowing, and wrong errors", () => {
    const variants = [
      validParser.replace("  for (let index", "  inQuotes = true;\n  for (let index"),
      validParser.replace("      if (text[index] === '\"') inQuotes = false;\n", ""),
      validParser.replace("index < text.length", "index < 1"),
      validParser.replace("    if (text[index] === '\"') inQuotes = true;", "    [text[index]].forEach(() => { inQuotes = true; inQuotes = false; });"),
      validParser.replace("    if (text[index] === '\"') inQuotes = true;", "    let inQuotes = false; inQuotes = true;"),
      validParser.replace("new SyntaxError", "new TypeError")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("rejects non-literal, member, expression-prefix, and dead-loop transitions", () => {
    const variants = [
      `const externalFlag = true;\n${validParser.replace("  if (inQuotes)", "  inQuotes = externalFlag;\n  if (inQuotes)")}`,
      validParser.replace("    if (text[index] === '\"') inQuotes = true;", "    const box = {}; box.inQuotes = true; box.inQuotes = false; inQuotes = externalFlag;"),
      validParser
        .replace("inQuotes = true;", "inQuotes = true && false;")
        .replace("inQuotes = false;", "inQuotes = false || true;"),
      `const externalFlag = true;\n${validParser
        .replace("index < text.length", "index < text.length && false")
        .replace("    if (text[index] === '\"') inQuotes = true;", "    inQuotes = externalFlag; inQuotes = false;")}`
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("rejects stale input provenance, dead branches, unconditional transitions, and declaration-after-loop", () => {
    const variants = [
      validParser.replace("  const text = String(input);", "  const text = String(input);\n  input = 'constant';")
        .replaceAll("text.length", "input.length"),
      validParser
        .replace("    if (text[index] === '\"') inQuotes = true;", "    if (false && text[index]) inQuotes = true;")
        .replace("      if (text[index] === '\"') inQuotes = false;", "      if (text[index] && false) inQuotes = false;"),
      validParser
        .replace("    if (text[index] === '\"') inQuotes = true;", "    inQuotes = true;")
        .replace("      if (text[index] === '\"') inQuotes = false;", "      inQuotes = false;"),
      validParser.replace("  let inQuotes = false;\n", "")
        .replace("  if (inQuotes)", "  let inQuotes = false;\n  if (inQuotes)")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("rejects input references confined to loop initialization", () => {
    const source = validParser.replace("let index = 0; index < text.length; index += 1", "let index = text.length; index < 0; index += 1");
    assert.equal(evidence(source).sourceOk, false);
  });

  it("rejects unreachable, side-effecting, and always-overwritten transition paths", () => {
    const variants = [
      parserWithLoop(["if (text[index]) { inQuotes = true; inQuotes = false; }"]),
      parserWithLoop(["if (text[index]) { if (false) inQuotes = true; else inQuotes = false; }"]),
      parserWithLoop(["if (text[index]) { continue; inQuotes = true; inQuotes = false; }"]),
      parserWithLoop(["if (text[index]) { break; inQuotes = true; inQuotes = false; }"]),
      parserWithLoop(["if (text[index] && 0) { inQuotes = true; inQuotes = false; }"]),
      parserWithLoop(["if ((input = '') && input[index]) { inQuotes = true; inQuotes = false; }"]),
      parserWithLoop(["if (text[index]) { inQuotes = true; inQuotes = false; }"], {
        header: "for (let index = 0; (text.length, false); index += 1)"
      }),
      parserWithLoop(["if (text[index]) { inQuotes = true; inQuotes = false; }"], {
        header: "for (let index = 0; index < text.length && never(); index += 1)"
      })
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("supports a narrow input-derived for-of shape and an explicit TS boolean state", () => {
    const forOf = parserWithLoop([
      "if (inQuotes) { if (character === '\"') inQuotes = false; continue; }",
      "if (character === '\"') inQuotes = true;"
    ], { header: "for (const character of text)" });
    const typed = parserWithLoop([
      "if (inQuotes) {",
      "  if (text[index] === '\"') inQuotes = false;",
      "  continue;",
      "}",
      "if (text[index] === '\"') inQuotes = true;"
    ], { declaration: "  let inQuotes: boolean = false;" });
    assert.deepEqual(evidence(forOf), { sourceOk: true, testOk: true });
    assert.deepEqual(evidence(typed), { sourceOk: true, testOk: true });
  });

  it("rejects dead counters, dead carriers, unrelated sentinels, and unrelated contracts", () => {
    const variants = [
      validParser.replace("let index = 0; index < text.length", "let index = text.length; index < text.length"),
      validParser.replace("index += 1", "index -= 1"),
      validParser.replace("const text = String(input);", "const text = false ? String(input) : '';"),
      validParser.replace("const text = String(input);", "const text = (input, '');"),
      validParser.replace("const text = String(input);", "const text = String(input).slice(0, 0);"),
      validParser.replaceAll("'\"'", "'z'")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
    assert.equal(evidence(validParser, focusedTest, "parseRecord(input) must reject a bad checksum with SyntaxError.").sourceOk, false);
  });

  it("rejects state machines behind dead or unmodeled control flow", () => {
    const variants = [
      validParser.replace("  for (let index", "  if (true) return [];\n  for (let index"),
      validParser.replace("  for (let index", "  while (true) {}\n  for (let index"),
      validParser.replace("    if (text[index] === '\"') inQuotes = true;", "    if (true === false) { if (text[index] === '\"') inQuotes = true; }"),
      parserWithLoop(["switch (0) { case 1: if (text[index] === '\"') { inQuotes = true; inQuotes = false; } }"]),
      parserWithLoop(["while (false) { if (text[index] === '\"') { inQuotes = true; inQuotes = false; } }"]),
      validParser.replace("  if (inQuotes)", "  if (true) return [];\n  if (inQuotes)"),
      validParser.replace("  if (inQuotes) throw", "  true ? inQuotes = false : 0;\n  if (inQuotes) throw")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("rejects forged sentinels, shadowed coercion, stale indexes, and dead carrier mutation", () => {
    const sentinel = "__pi_double_quote_string_literal__";
    const directCarrier = validParser.replace("  const text = String(input);\n", "").replaceAll("text", "input");
    const variants = [
      `const ${sentinel} = 'z';\n${validParser.replaceAll("'\"'", sentinel)}`,
      `const String = () => '';\n${validParser}`,
      `function String() { return ''; }\n${validParser}`,
      validParser.replace("  const text = String(input);", "  const String = () => '';\n  const text = String(input);"),
      validParser.replace("export function parseRecord(input) {", "export function parseRecord(input) {\n  var input = '';"),
      validParser.replaceAll("text[index]", "text[999]"),
      validParser.replace("  for (let index = 0; index < text.length; index += 1) {", "  for (let index = 0; index < text.length; index += 1) {\n    const index = 999;"),
      validParser.replace("  for (let index = 0; index < text.length; index += 1) {", "  for (let index = 0; index < text.length; index += 1) {\n    index = text.length;"),
      validParser.replace("  let inQuotes = false;", "  text.length = 0;\n  let inQuotes = false;"),
      directCarrier.replace("  for (let index = 0; index < input.length; index += 1) {", "  for (let index = 0; index < input.length; index += 1) {\n    input.length = 0;"),
      directCarrier.replace("  let inQuotes = false;", "  input.splice(0);\n  let inQuotes = false;")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("rejects constant-false predicates, dominant exits, dormant methods, and negated contracts", () => {
    const dormant = parserWithLoop([
      "const dormant = { run() {",
      "  if (text[index] === '\"') inQuotes = true;",
      "  else if (text[index] === '\"') inQuotes = false;",
      "} };"
    ]);
    const variants = [
      validParser.replace("text[index] === '\"') inQuotes = true", "text[index] === '\"' && 1 === 2) inQuotes = true"),
      validParser.replace("    if (inQuotes) {", "    if (1 === 1) continue;\n    if (inQuotes) {"),
      ...["NaN", "0n", "void 0", "!1"].map((dead) => validParser.replace(
        "    if (text[index] === '\"') inQuotes = true;",
        `    if (text[index] === '\"' && ${dead}) inQuotes = true;`
      )),
      ...["'x'", "[]", "{}", "42", "!false"].map((truthy) => validParser.replace(
        "    if (inQuotes) {", `    if (${truthy}) continue;\n    if (inQuotes) {`
      )),
      `function abort() { throw new RangeError('abort'); }\n${validParser.replace("  for (let index", "  abort();\n  for (let index")}`,
      `function abort() { throw new RangeError('abort'); }\n${validParser.replace("  for (let index = 0; index < text.length; index += 1) {", "  for (let index = 0; index < text.length; index += 1) {\n    abort();")}`,
      validParser.replace("if (text[index] === '\"') inQuotes = true;", "if (text[index] === '\"') { inQuotes = true; return []; }"),
      validParser.replace("if (text[index] === '\"') inQuotes = true;", "if (text[index] === '\"') { inQuotes = true; throw new RangeError('wrong'); }"),
      `function abort() { throw new RangeError('abort'); }\n${validParser.replace("if (text[index] === '\"') inQuotes = true;", "if (text[index] === '\"') { inQuotes = true; abort(); }")}`,
      validParser.replace("  if (inQuotes) throw", "  abort();\n  if (inQuotes) throw"),
      dormant
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
    const negated = "parseRecord(input) must never throw SyntaxError for an unterminated quoted field.";
    const unrelated = "Do not treat an unterminated quoted field as a checksum error; parseRecord(input) must throw SyntaxError for bad checksum.";
    assert.equal(evidence(validParser, focusedTest, negated).sourceOk, false);
    assert.equal(evidence(validParser, focusedTest, unrelated).sourceOk, false);
    assert.equal(evidence(validParser, focusedTest, "Update parseRecord. parseOther(input) must throw SyntaxError for an unterminated quoted field.").sourceOk, false);
    assert.equal(evidence(validParser, focusedTest, "Update parseRecord. parseOther must throw SyntaxError for an unterminated quoted field.").sourceOk, false);
  });

  it("rejects unmodeled statements, call syntax, carrier aliases, and destructured counters", () => {
    const abort = "function abort() { throw new RangeError('abort'); }\n";
    const variants = [
      validParser.replace("  const text", "  MISSING;\n  const text"),
      validParser.replace("    if (inQuotes)", "    null.missing;\n    if (inQuotes)"),
      `${abort}${validParser.replace("    if (inQuotes)", "    abort?.();\n    if (inQuotes)")}`,
      `${abort}${validParser.replace("  const text", "  abort`tag`;\n  const text")}`,
      validParser.replace("  const text", "  input.length = 0;\n  const text"),
      validParser.replace("  let inQuotes", "  const alias = text; alias.extra = 1;\n  let inQuotes"),
      validParser.replace("    if (inQuotes)", "    [index] = [text.length];\n    if (inQuotes)"),
      validParser.replace("    if (inQuotes)", "    missing = null.x;\n    if (inQuotes)"),
      validParser.replace("    if (inQuotes)", "    missing.x = 1;\n    if (inQuotes)"),
      validParser.replace("    if (inQuotes)", "    ({}).missing.value;\n    if (inQuotes)"),
      validParser.replace("  let inQuotes = false;", "  let inQuotes = false;\n  let closedQuote = false;")
        .replace("      continue;", "      if (null.x) closedQuote = true;\n      continue;")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("proves empty-guard bindings and the complete state-guard exit", () => {
    const variants = [
      validParser.replace("if (text[index] === '\"') inQuotes = true", "if (text[index] === '\"' && inQuotes === '') inQuotes = true"),
      validParser.replace("      continue;", "      return [];"),
      validParser.replace("      continue;", "      throw new RangeError('wrong error');"),
      validParser.replace("      if (text[index] === '\"') inQuotes = false;", "      if (text[index] === '\"') { inQuotes = false; return []; }"),
      validParser.replace("      if (text[index] === '\"') inQuotes = false;", "      if (text[index] === '\"') { inQuotes = false; missing = null.x; }")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
  });

  it("keeps async source proof independent while requiring assertion parity in test proof", () => {
    const asynchronous = validParser.replace("export function", "export async function");
    const rejectingTest = focusedTest.replace("assert.throws", "await assert.rejects");
    assert.deepEqual(evidence(asynchronous), { sourceOk: true, testOk: false });
    assert.deepEqual(evidence(asynchronous, rejectingTest), { sourceOk: true, testOk: true });
  });

  it("reports ordinary conditional assertion mismatch only in test proof", () => {
    const direct = "export function parseRecord(input) { if (!input) throw new SyntaxError('unterminated quoted field'); return []; }";
    const asynchronous = direct.replace("export function", "export async function");
    const rejectingTest = focusedTest.replace("assert.throws", "await assert.rejects");
    assert.deepEqual(evidence(asynchronous), { sourceOk: true, testOk: false });
    assert.deepEqual(evidence(direct, rejectingTest), { sourceOk: true, testOk: false });
    assert.deepEqual(evidence(asynchronous, rejectingTest), { sourceOk: true, testOk: true });
  });

  it("binds an affirmative contract uniquely and normalizes negative contractions", () => {
    const contracts = [
      "parseRecord(input) shouldn't throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) can't throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) cannot throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) won't throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) shan't throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) fails to throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) remains unchanged while parseOther(input) must throw SyntaxError for an unterminated quoted field.",
      "parseRecord and parseOther must throw SyntaxError for an unterminated quoted field.",
      "Update parseRecord and parseOther. Must throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) and parseOther must throw SyntaxError for an unterminated quoted field.",
      "Update parseRecord. Must throw SyntaxError for an unterminated quoted field. Update parseOther.",
      "Update parseRecord(input) not to throw. Throw SyntaxError for an unterminated quoted field.",
      "Throw SyntaxError for an unterminated quoted field. Keep the parseRecord(input) function unchanged.",
      "Update parseRecord(input) to avoid throwing. Throw SyntaxError for an unterminated quoted field.",
      "Ignore the parseRecord(input) function. Throw SyntaxError for an unterminated quoted field.",
      "parseRecord(input) delegates to parseOther which must throw SyntaxError for an unterminated quoted field.",
      "parseOther rather than parseRecord(input) must throw SyntaxError for an unterminated quoted field.",
      "The parseRecord(input) docs say parseOther must throw SyntaxError for an unterminated quoted field."
    ];
    for (const taskText of contracts) assert.equal(evidence(validParser, focusedTest, taskText).sourceOk, false, taskText);
    assert.deepEqual(evidence(validParser, focusedTest, "Update parseRecord(input). Throw SyntaxError for an unterminated quoted field."), { sourceOk: true, testOk: true });
  });

  it("rejects side effects and unresolved values in terminal error arguments", () => {
    const variants = [
      validParser.replace("new SyntaxError('unterminated')", "new SyntaxError(missing)"),
      validParser.replace("new SyntaxError('unterminated')", "new SyntaxError((abort(), 0))"),
      validParser.replace("new SyntaxError('unterminated')", "new SyntaxError((() => { throw new RangeError(); })())"),
      validParser.replace("new SyntaxError('unterminated')", "new SyntaxError(new Proxy({}, {}))"),
      validParser.replace("new SyntaxError('unterminated')", "new SyntaxError(`unterminated ${abort()}`)")
    ];
    for (const source of variants) assert.equal(evidence(source).sourceOk, false, source);
    const asynchronous = validParser.replace("export function", "export async function")
      .replace("new SyntaxError('unterminated')", "new SyntaxError(await abort())");
    assert.equal(evidence(asynchronous, focusedTest.replace("assert.throws", "await assert.rejects")).sourceOk, false);
  });

  it("rejects dangling-else control flow that only appears to open quote state", () => {
    const source = parserWithLoop([
      "if (inQuotes)",
      "  if (text[index] === '\"') inQuotes = false;",
      "  else",
      "    if (text[index] === '\"') inQuotes = true;"
    ]);
    assert.equal(evidence(source).sourceOk, false);
  });

  it("rejects a prior sibling whose else branch bypasses the opening transition", () => {
    const source = validParser.replace("  let inQuotes = false;", "  let inQuotes = false;\n  let blocked = false;")
      .replace("    if (text[index] === '\"') inQuotes = true;", "    if (blocked) {} else continue;\n    if (text[index] === '\"') inQuotes = true;");
    assert.equal(evidence(source).sourceOk, false);
  });

  it("rejects a correlated prior sibling that exits on the opening quote", () => {
    const source = validParser.replace("    if (text[index] === '\"') inQuotes = true;", "    if (text[index] === '\"') { continue; }\n    if (text[index] === '\"') inQuotes = true;");
    assert.equal(evidence(source).sourceOk, false);
  });
});
