import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeToolCall, toolResultPreview } from "../packages/piagent-webui/server/tool-call-summary.ts";

// What a tool step shows in the WebUI never carries a credential, whatever
// the tool and however the text is cut for display.
const joined = (...parts) => parts.join("");
const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const pem = joined("-----BEGIN", " PRIVATE KEY-----\n", pemBody, "\nSECRETBODYLINETWOabcdefghijklmnop\n-----END PRIVATE KEY-----\n");
const studioKey = ["as", "live", "0f8b2c1e-1234-4abc-9def-0123456789ab", "Zq0Xy_9-AbCdEfGhIjKlMnOpQrStUvWxYz012345678"].join("_");
const openAiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");

test("writing or editing a private key shows the key redacted, not its lines", () => {
  // The preview was split into rows before redaction, and a key is
  // recognised only while its lines are together.
  for (const shown of [summarizeToolCall("write", { path: "deploy/key.pem", content: pem }), summarizeToolCall("edit", { path: "deploy/key.pem", edits: [{ oldText: "placeholder", newText: pem }] })]) {
    const text = JSON.stringify(shown);
    assert.equal(text.includes(pemBody), false);
    assert.equal(text.includes("SECRETBODYLINETWO"), false);
    assert.match(shown.change.preview, /\[REDACTED_SECRET\]/);
  }
});

test("commands and results hide credentials, also where the command is cut for display", () => {
  assert.equal(JSON.stringify(summarizeToolCall("bash", { command: `echo ${studioKey}` })).includes("Zq0Xy_9-AbCd"), false);
  for (let cut = 340; cut <= 400; cut += 3) {
    const command = `${"--flag value ".repeat(40).slice(0, cut)} ${openAiKey} && echo done`;
    assert.equal(JSON.stringify(summarizeToolCall("bash", { command })).includes("abcdefghijkl"), false, `cut ${cut}`);
  }
  const result = toolResultPreview({ role: "toolResult", isError: false, content: [{ type: "text", text: `export AS=${studioKey}\n` }] });
  assert.equal(result.text.includes("Zq0Xy_9-AbCd"), false);
});

// A model that edits through apply_patch gets the same "Edit <file>" card and
// diff as one using edit, with the patch redacted as a whole.
test("an apply_patch call reads as an edit of its files with the patch's diff", () => {
  const patch = ["*** Begin Patch", "*** Update File: /work/shop/src/cart.js", "@@ export function subtotal", " const a = 1;",
    "-const total = 0;", "+const total = items.length;", "*** Add File: src/new.js", "+export const token = \"as_live_" + "a".repeat(40) + "\";", "*** End Patch"].join("\n");
  const shown = summarizeToolCall("apply_patch", { patch }, "/work/shop");
  assert.deepEqual(shown.summary, { kind: "edit", target: "src/cart.js +1", detail: null });
  assert.equal(shown.change.added, 2); assert.equal(shown.change.removed, 1);
  assert.match(shown.change.preview, /-const total = 0;\n\+const total = items\.length;/);
  assert.doesNotMatch(JSON.stringify(shown), /as_live_a{40}/);
  assert.equal(summarizeToolCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch" }).summary.kind, "write");
});

test("an experiment run reads as the command it runs", () => {
  assert.deepEqual(summarizeToolCall("run_experiment", { command: "npm run bench", timeout_seconds: 60 }).summary, { kind: "command", target: "npm run bench", detail: null });
});
