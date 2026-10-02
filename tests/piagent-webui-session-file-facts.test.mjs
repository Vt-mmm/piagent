import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cachedSessionFacts } from "../packages/piagent-webui/gateway/session-file-facts.ts";

// Every catalog used to parse every conversation file. A file is read again
// only when it changed; what a read returns is exactly what reading gives.
test("a conversation file is parsed again only after it changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-file-facts-"));
  try {
    const file = path.join(root, "s.jsonl"), reads = [];
    const facts = cachedSessionFacts((name) => { reads.push(name); return { lines: fs.readFileSync(name, "utf8").split("\n").filter(Boolean).length }; });
    fs.writeFileSync(file, "{}\n");
    assert.deepEqual(facts(file), { lines: 1 });
    assert.deepEqual(facts(file), { lines: 1 });
    assert.equal(reads.length, 1, "unchanged: not read again");

    fs.appendFileSync(file, "{}\n");
    assert.deepEqual(facts(file), { lines: 2 });
    assert.equal(reads.length, 2, "appended: read again");

    // Replaced by another file of the same size and time: a new inode.
    const other = path.join(root, "other.jsonl"), stat = fs.statSync(file);
    fs.writeFileSync(other, "[]\n[]\n[]\n".slice(0, stat.size));
    fs.utimesSync(other, stat.atime, stat.mtime);
    fs.renameSync(other, file);
    facts(file);
    assert.equal(reads.length, 3, "replaced: read again");

    fs.rmSync(file);
    assert.throws(() => facts(file), /ENOENT/);
    fs.writeFileSync(file, "{}\n");
    assert.deepEqual(facts(file), { lines: 1 }, "gone and back: read again");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a read that fails is not kept", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-file-facts-"));
  try {
    const file = path.join(root, "s.jsonl");
    fs.writeFileSync(file, "broken\n");
    let fail = true;
    const facts = cachedSessionFacts(() => { if (fail) throw new Error("unreadable"); return "ok"; });
    assert.throws(() => facts(file), /unreadable/);
    fail = false;
    assert.equal(facts(file), "ok");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
