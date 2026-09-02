import {
  callReturns,
  callThrows,
  protocolRecord,
  recipe,
  utf8Chunks
} from "./benchmark-registered-plan-recipe-support.mjs";

function unicodeRecipe() {
  return recipe("src/frontend/unicode-search.js", "normalizeSearchText", [
    callReturns("normalize-null", [null], ""),
    callReturns("normalize-undefined", [undefined], ""),
    callReturns("normalize-case-accent-space", ["  CAFÉ\t au   LAIT  "], "cafe au lait"),
    callReturns("normalize-decomposed", [" A\u030Angstro\u0308m "], "angstrom"),
    callReturns("normalize-nondecomposable", ["  Øresund  "], "øresund"),
    callReturns("includes-accent-case-space", ["  Café   au LAIT ", "cafe au"], true,
      { exportName: "includesSearchText" }),
    callReturns("includes-decomposed", ["Ångström", "angstrom"], true,
      { exportName: "includesSearchText" }),
    callReturns("includes-null-safe", [null, "x"], false, { exportName: "includesSearchText" }),
    callReturns("includes-null-query", ["anything", null], true, { exportName: "includesSearchText" }),
    callReturns("includes-miss", ["résumé", "sumo"], false, { exportName: "includesSearchText" })
  ]);
}

function csvRecipe() {
  return recipe("src/data/csv.js", "parseCsv", [
    callReturns("empty", [""], [], { fresh: true }),
    callReturns("simple-final-record", ["a,b"], [["a", "b"]], { fresh: true }),
    callReturns("empty-physical-record", ["\n"], [[""]], { fresh: true }),
    callReturns("trailing-terminator", ["a\n"], [["a"]], { fresh: true }),
    callReturns("empty-fields", [",,"], [["", "", ""]], { fresh: true }),
    callReturns("quoted-comma", ["\"a,b\",c"], [["a,b", "c"]], { fresh: true }),
    callReturns("escaped-quote", ["\"a\"\"b\""], [["a\"b"]], { fresh: true }),
    callReturns("crlf-records", ["a,b\r\nc,d\r\n"], [["a", "b"], ["c", "d"]], { fresh: true }),
    callReturns("quoted-lf", ["\"a\nb\",c"], [["a\nb", "c"]], { fresh: true }),
    callReturns("quoted-crlf-preserved", ["\"a\r\nb\",c"], [["a\r\nb", "c"]], { fresh: true }),
    callReturns("quoted-empty", ["\"\""], [[""]], { fresh: true }),
    callReturns("whitespace-preserved", [" a , b "], [[" a ", " b "]], { fresh: true }),
    callThrows("unterminated-quote", ["\"a"], "SyntaxError"),
    callThrows("quote-in-unquoted-field", ["a\"b"], "SyntaxError"),
    callThrows("text-after-closing-quote", ["\"a\"x"], "SyntaxError"),
    callThrows("bare-cr", ["a\rb"], "SyntaxError"),
    callThrows("nonstring-null", [null]),
    callThrows("nonstring-number", [1]),
    callThrows("nonstring-array", [[]])
  ]);
}

function ndjsonRecipe() {
  const splitUnicode = utf8Chunks('{"text":"é😀"}\n', [10, 13]);
  return recipe("src/data/ndjson-stream.js", "parseNdjsonChunks", [
    callReturns("no-chunks", [[]], [], { fresh: true }),
    callReturns("one-final-record", [utf8Chunks('{"id":1}')], [{ id: 1 }], { fresh: true }),
    callReturns("lf-records-and-empty-lines", [utf8Chunks('{"id":1}\n\n{"id":2}\n')],
      [{ id: 1 }, { id: 2 }], { fresh: true }),
    callReturns("crlf-records", [utf8Chunks('{"id":1}\r\n{"id":2}\r\n')],
      [{ id: 1 }, { id: 2 }], { fresh: true }),
    callReturns("ascii-split", [utf8Chunks('{"value":"split"}\n', [2, 7, 12])],
      [{ value: "split" }], { fresh: true }),
    callReturns("unicode-split-inside-codepoints", [splitUnicode], [{ text: "é😀" }], { fresh: true }),
    callReturns("empty-chunks", [[new Uint8Array(), ...utf8Chunks('0\nnull\n'), new Uint8Array()]],
      [0, null], { fresh: true }),
    callReturns("json-array-record", [utf8Chunks('[1,2,3]\n')], [[1, 2, 3]], { fresh: true }),
    callThrows("invalid-utf8", [[new Uint8Array([0xc3, 0x28])]]),
    callThrows("invalid-json", [utf8Chunks('{]\n')], "SyntaxError")
  ]);
}

function migrationRecipe() {
  const v2 = { version: 2, enabled: false, retryLimit: 0, label: "", metadata: { owner: "ops" } };
  const freshPairs = [{ id: "fresh-outer", left: { root: "return", path: [] },
    right: { root: "argument", index: 0, path: [] } }];
  return recipe("src/data/migration.js", "migrateSettings", [
    callReturns("default-argument", [], { version: 2, enabled: true, retryLimit: 3, label: "default" }, { fresh: true }),
    callReturns("v1-falsey-values", [{ version: 1, enabled: false, retries: 0, name: "" }],
      { version: 2, enabled: false, retryLimit: 0, label: "" }, { fresh: true }),
    callReturns("v1-nullish-defaults", [{ version: 1, enabled: null, retries: null, name: null }],
      { version: 2, enabled: true, retryLimit: 3, label: "default" }, { fresh: true }),
    callReturns("v1-mixed-values", [{ version: 1, enabled: true, retries: 8, name: "nightly" }],
      { version: 2, enabled: true, retryLimit: 8, label: "nightly" }, { fresh: true }),
    callReturns("v2-independent-outer-copy", [v2], v2,
      { fresh: true, referencePairs: freshPairs,
        referenceIdentity: [{ id: "fresh-outer", same: false }] })
  ]);
}

function dedupRecipe() {
  return recipe("src/data/dedup.js", "deduplicateEvents", [
    callReturns("empty", [[]], [], { fresh: true }),
    callReturns("first-id-order-latest-value", [[
      { id: "a", sequence: 1, value: "old-a" },
      { id: "b", sequence: 9, value: "b" },
      { id: "a", sequence: 3, value: "new-a" }
    ]], [{ id: "a", sequence: 3, value: "new-a" }, { id: "b", sequence: 9, value: "b" }], { fresh: true }),
    callReturns("later-tie-wins", [[
      { id: "a", sequence: 5, value: "first" },
      { id: "a", sequence: 5, value: "later" }
    ]], [{ id: "a", sequence: 5, value: "later" }], { fresh: true }),
    callReturns("greatest-numeric-sequence", [[
      { id: "a", sequence: -2, value: "negative" },
      { id: "a", sequence: 0.5, value: "fraction" },
      { id: "a", sequence: 0, value: "zero" }
    ]], [{ id: "a", sequence: 0.5, value: "fraction" }], { fresh: true }),
    callReturns("stable-distinct-order", [[
      { id: "z", sequence: 0 }, { id: "a", sequence: 100 }, { id: "m", sequence: 2 }
    ]], [{ id: "z", sequence: 0 }, { id: "a", sequence: 100 }, { id: "m", sequence: 2 }], { fresh: true })
  ]);
}

function replayRecipe() {
  const empty = () => ({ entities: {}, appliedEventIds: [] });
  const event = overrides => ({ eventId: "event-1", entityId: "entity-1", expectedVersion: 0,
    nextValue: { name: "first" }, ...overrides });
  const freshPairs = [
    { id: "fresh-state", left: { root: "return", path: [] }, right: { root: "argument", index: 0, path: [] } },
    { id: "fresh-entities", left: { root: "return", path: ["entities"] }, right: { root: "argument", index: 0, path: ["entities"] } },
    { id: "fresh-applied", left: { root: "return", path: ["appliedEventIds"] }, right: { root: "argument", index: 0, path: ["appliedEventIds"] } }
  ];
  const specialInitial = protocolRecord([["entities", protocolRecord([])], ["appliedEventIds", []]]);
  const specialExpected = protocolRecord([["entities", protocolRecord([["__proto__", { version: 1, value: "safe" }]])],
    ["appliedEventIds", ["special"]]]);
  return recipe("src/data/versioned-replay.js", "replayVersionedEvents", [
    callReturns("empty-events-fresh-containers", [empty(), []], empty(), { fresh: true,
      referencePairs: freshPairs, referenceIdentity: freshPairs.map(pair => ({ id: pair.id, same: false })) }),
    callReturns("one-new-entity", [empty(), [event({})]],
      { entities: { "entity-1": { version: 1, value: { name: "first" } } }, appliedEventIds: ["event-1"] }, { fresh: true }),
    callReturns("ordered-version-advance", [empty(), [event({}), event({ eventId: "event-2", expectedVersion: 1,
      nextValue: { name: "second" } })]],
      { entities: { "entity-1": { version: 2, value: { name: "second" } } }, appliedEventIds: ["event-1", "event-2"] }, { fresh: true }),
    callReturns("initially-applied-idempotent", [{ entities: { "entity-1": { version: 4, value: "kept" } },
      appliedEventIds: ["event-1"] }, [event({ expectedVersion: 999, nextValue: "ignored" })]],
      { entities: { "entity-1": { version: 4, value: "kept" } }, appliedEventIds: ["event-1"] }, { fresh: true }),
    callReturns("duplicate-in-batch-idempotent", [empty(), [event({ nextValue: "first" }),
      event({ expectedVersion: 999, nextValue: "ignored" })]],
      { entities: { "entity-1": { version: 1, value: "first" } }, appliedEventIds: ["event-1"] }, { fresh: true }),
    callReturns("literal-special-entity-id", [specialInitial,
      [{ eventId: "special", entityId: "__proto__", expectedVersion: 0, nextValue: "safe" }]], specialExpected, { fresh: true }),
    callThrows("absent-entity-version-conflict", [empty(), [event({ expectedVersion: 1 })]], "Error"),
    callThrows("maximum-safe-increment", [{ entities: { "entity-1": { version: Number.MAX_SAFE_INTEGER, value: null } },
      appliedEventIds: [] }, [event({ expectedVersion: Number.MAX_SAFE_INTEGER })]]),
    callThrows("malformed-later-outranks-conflict", [empty(), [event({ expectedVersion: 1 }),
      { eventId: "later", entityId: "entity-2", expectedVersion: 0 }]]),
    callThrows("malformed-duplicate-still-invalid", [empty(), [event({}),
      { eventId: "event-1", entityId: "entity-1", expectedVersion: 999 }]]),
    callThrows("duplicate-initial-applied-ids", [{ entities: {}, appliedEventIds: ["same", "same"] }, []]),
    callThrows("unsafe-entity-version", [{ entities: { x: { version: Number.MAX_SAFE_INTEGER + 1, value: null } },
      appliedEventIds: [] }, []]),
    callThrows("nonfinite-json-value", [empty(), [event({ nextValue: { invalid: NaN } })]])
  ]);
}

const RECIPES = Object.freeze({
  "unicode-search": unicodeRecipe,
  "quoted-csv": csvRecipe,
  "chunked-record-boundary": ndjsonRecipe,
  "schema-migration": migrationRecipe,
  "stable-dedup": dedupRecipe,
  "idempotent-replay-conflict": replayRecipe
});

export function registeredDataRecipe(scenarioId) {
  return RECIPES[scenarioId]?.() ?? null;
}
