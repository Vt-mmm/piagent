import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { cachedSessionLister } from "../packages/piagent-webui/gateway/session-list-cache.ts";

const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), ".pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent");
const supported = fs.existsSync(path.join(sdkRoot, "dist/index.js"));

function session(file, { id, cwd, at, messages, name }) {
  const lines = [{ type: "session", version: 3, id, timestamp: at, cwd }];
  if (name) lines.push({ type: "session_info", id: `${id}-n`, parentId: null, timestamp: at, name });
  messages.forEach(([role, text], index) => lines.push({ type: "message", id: `${id}-${index}`, parentId: null, timestamp: at,
    message: { role, content: [{ type: "text", text }], timestamp: Date.parse(at) + index * 1000 } }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}
const shape = (infos) => infos.map((i) => [i.path, i.id, i.cwd, i.name ?? null, i.messageCount, i.firstMessage, i.allMessagesText, i.modified.toISOString()]);

// The dashboard lists conversations on every catalog: hundreds of them used to
// be read in full each time. Unchanged files keep their info; what is read is
// read by Pi, so the list is the one Pi gives.
test("the cached list is Pi's list, and only changed files are read again", { skip: !supported }, async () => {
  const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-list-cache-"));
  try {
    for (const flat of [false, true]) {
      const dir = path.join(root, flat ? "flat" : "nested"), at = (n) => `2026-10-02T0${n}:00:00.000Z`;
      const file = (project, n) => flat ? path.join(dir, `s${n}.jsonl`) : path.join(dir, `--${project}--`, `s${n}.jsonl`);
      session(file("a", 1), { id: "s1", cwd: "/work/a", at: at(1), messages: [["user", "first question"], ["assistant", "an answer"]], name: "Named" });
      session(file("a", 2), { id: "s2", cwd: "/work/a", at: at(2), messages: [] });
      session(file("b", 3), { id: "s3", cwd: "/work/b", at: at(3), messages: [["user", "other project"]] });
      fs.writeFileSync(flat ? path.join(dir, "not-a-session.jsonl") : path.join(dir, "--b--", "not-a-session.jsonl"), "{\"type\":\"note\"}\n");
      const reads = [];
      const listAll = (sessionDir) => { reads.push(fs.readdirSync(sessionDir).length); return SessionManager.listAll(sessionDir); };
      const list = cachedSessionLister(listAll, dir, flat);
      const pi = async () => flat ? SessionManager.listAll(dir)
        : (await Promise.all(fs.readdirSync(dir).map((folder) => SessionManager.listAll(path.join(dir, folder))))).flat().sort((a, b) => b.modified - a.modified);
      assert.deepEqual(shape(await list()), shape(await pi()), `first list (${flat ? "flat" : "nested"})`);
      assert.deepEqual(reads, [4]);
      assert.deepEqual(shape(await list()), shape(await pi()));
      assert.deepEqual(reads, [4], "nothing changed: nothing read");
      session(file("a", 2), { id: "s2", cwd: "/work/a", at: at(2), messages: [["user", "now it has a message"]] });
      fs.utimesSync(file("a", 2), new Date(), new Date(Date.now() + 5000));
      assert.deepEqual(shape(await list()), shape(await pi()));
      assert.deepEqual(reads, [4, 1], "only the changed file is read again");
      fs.rmSync(file("b", 3));
      assert.deepEqual(shape(await list()).map((row) => row[1]), ["s2", "s1"], "a removed conversation leaves the list");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
