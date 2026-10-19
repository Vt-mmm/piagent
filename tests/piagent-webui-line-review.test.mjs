import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { managedProjection } from "../packages/piagent-webui/gateway/managed-projection.ts";
import { changedSince, fileFindings, findingsAt, readComments, reviewMessage, samePath, upsertComment, writeComments }
  from "../packages/piagent-webui/client/src/line-review.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

// Review on the diff: comments on lines of two files go out as one message
// with a file:line anchor and the code of each line, in file and line order;
// the review helper's findings reach the session row and land on their line.
const root = path.resolve(import.meta.dirname, "..");

test("comments on two files become one message with file:line anchors and the code", () => {
  let comments = upsertComment([], { path: "src/cart.ts", line: 42, side: "new", code: "total += price * qty;", text: "Use integer cents here." });
  comments = upsertComment(comments, { path: "api/refund.go", line: 7, side: "new", code: "amount := float64(c)", text: "No floats for money." });
  comments = upsertComment(comments, { path: "src/cart.ts", line: 3, side: "old", code: "import x from 'y';", text: "Why was this removed?" });
  comments = upsertComment(comments, { path: "src/cart.ts", line: 42, side: "new", code: "total += price * qty;", text: "  Use integer cents (edited).  " });
  assert.equal(comments.length, 3, "a second comment on a line replaces the first");
  const message = reviewMessage(comments, true);
  assert.equal(message, [
    "Review comments on the diff (3). Address each one at its file and line:",
    "1. api/refund.go:7\n```\namount := float64(c)\n```\nNo floats for money.",
    "2. src/cart.ts:3 (removed line)\n```\nimport x from 'y';\n```\nWhy was this removed?",
    "3. src/cart.ts:42\n```\ntotal += price * qty;\n```\nUse integer cents (edited).",
  ].join("\n\n"));
  assert.match(reviewMessage(comments, false), /^Review comment trên diff \(3\)\./);
  assert.match(reviewMessage([{ ...comments[0], code: "```fence```" }], true), /````\n```fence```\n````/, "a fence in the code gets a longer fence");
  assert.equal(upsertComment(comments, { path: "src/cart.ts", line: 42, side: "new", code: "", text: "   " }).length, 2, "an empty text removes the comment");
});

test("comments last in the tab per conversation and a changed line is flagged", () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    const comments = upsertComment([], { path: "a.ts", line: 1, side: "new", code: "let a = 1;", text: "const" });
    writeComments("session.one", comments);
    assert.deepEqual(readComments("session.one"), comments); assert.deepEqual(readComments("session.two"), []);
    store.set("piagent-line-comments:session.bad", "{not json"); assert.deepEqual(readComments("session.bad"), []);
    writeComments("session.one", []); assert.equal(store.has("piagent-line-comments:session.one"), false);
    assert.equal(changedSince(comments[0], new Map([["new:1:a.ts", "let a = 1;"]])), false);
    assert.equal(changedSince(comments[0], new Map([["new:1:a.ts", "const a = 1;"]])), true);
    assert.equal(changedSince(comments[0], new Map()), true, "a line gone from the diff was changed");
  } finally { delete globalThis.sessionStorage; }
});

test("the review helper's findings reach the session row, valid for its schema, and land on their line", () => {
  const context = { model: { provider: "agent_watch_managed" } };
  const review = (data) => ({ type: "custom", customType: "agent-watch-review", data });
  const findings = [
    { severity: "blocking", file: "./src/cart.ts", line: 42, issue: "Float money.", evidence: "src/cart.ts:42" },
    { severity: "minor", file: "src/cart.ts", line: null, issue: "Name the constant." },
    { severity: "nit", file: "src/cart.ts", line: 1, issue: "unknown severity" },
    { severity: "major", file: "", line: 2, issue: "no file" },
  ];
  const out = managedProjection(context, [review({ findings: [{ severity: "major", file: "old.ts", line: 1, issue: "older" }] }), review({ stale: false, findings, parsed: true })]);
  assert.deepEqual(out.managedReview, { stale: false, findings: [
    { severity: "blocking", file: "./src/cart.ts", line: 42, issue: "Float money." }, { severity: "minor", file: "src/cart.ts", line: null, issue: "Name the constant." }] });
  assert.equal(managedProjection(context, [review({ stale: true, findings: [] })]).managedReview.stale, true);
  assert.equal(managedProjection(context, [review({ parsed: false })]).managedReview, undefined);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/session-catalog-v1.valid.json"), "utf8"));
  catalog.sessions[0].managedReview = out.managedReview;
  const registry = createWebUiSchemaRegistry();
  assert.equal(validateFixture(registry, "session-catalog-v1", catalog).valid, true, JSON.stringify(validateFixture(registry, "session-catalog-v1", catalog).errors));
  catalog.sessions[0].managedReview = { stale: false, findings: [{ severity: "nit", file: "a", line: 0, issue: "x" }] };
  assert.equal(validateFixture(registry, "session-catalog-v1", catalog).valid, false);

  const row = out.managedReview.findings;
  assert.ok(samePath("./src/cart.ts", "src/cart.ts") && samePath("cart.ts", "src/cart.ts") && samePath("/repo/src/cart.ts", "src/cart.ts"));
  assert.equal(samePath("art.ts", "src/cart.ts"), false);
  assert.deepEqual(findingsAt(row, "src/cart.ts", 42).map((f) => f.issue), ["Float money."]);
  assert.deepEqual(findingsAt(row, "src/other.ts", 42), []);
  assert.deepEqual(fileFindings(row, "src/cart.ts", new Set([42])).map((f) => f.issue), ["Name the constant."]);
  assert.deepEqual(fileFindings(row, "src/cart.ts", new Set([7])).map((f) => f.issue), ["Float money.", "Name the constant."]);
});
