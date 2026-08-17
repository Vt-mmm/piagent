import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildSessionCatalog } from "../packages/piagent-webui/gateway/session-catalog.ts";
import { SessionMetadataStore } from "../packages/piagent-webui/gateway/session-metadata-store.ts";

describe("Piagent Gateway session metadata overlay", () => {
  it("chains owner-only metadata with CAS and degrades safely on corruption", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-metadata-"));
    try {
      const store = new SessionMetadataStore(root, Buffer.alloc(32, 7));
      const first = store.update("session_alpha", null, {
        pinned: true, unread: true, projectGroup: "Team sk-proj-abcdefghijklmnopqrstuvwxyz"
      }, new Date("2026-08-14T06:00:00.000Z"));
      assert.equal(first.pinned, true);
      assert.equal(first.unread, true);
      assert.equal(first.projectGroup.includes("sk-proj-"), false);
      assert.equal(first.projectGroup.includes("[REDACTED_SECRET]"), true);
      assert.throws(() => store.update("session_alpha", null, { archived: true }), /stale-revision/);
      const archived = store.update("session_alpha", first.revision, { archived: true }, new Date("2026-08-14T06:01:00.000Z"));
      assert.equal(archived.archived, true);
      assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
      fs.appendFileSync(store.file, "{corrupt\n");
      const degraded = store.read();
      assert.equal(degraded.state, "unavailable");
      assert.equal(degraded.sessions.size, 0);
      assert.equal(degraded.reasonCode, "metadata-overlay-unavailable");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("merges pin/archive metadata into the bounded redacted catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-catalog-metadata-"));
    try {
      const key = Buffer.alloc(32, 9), store = new SessionMetadataStore(root, key);
      const infos = [
        { path: "/private/session-a.jsonl", id: "raw-a", cwd: "/private/project-a", name: "Older pinned",
          created: new Date("2026-08-10T00:00:00.000Z"), modified: new Date("2026-08-10T01:00:00.000Z"),
          messageCount: 2, firstMessage: "Pinned conversation", allMessagesText: "Pinned conversation reply" },
        { path: "/private/session-b.jsonl", id: "raw-b", cwd: "/private/project-b", name: "Recent archived",
          created: new Date("2026-08-13T00:00:00.000Z"), modified: new Date("2026-08-13T01:00:00.000Z"),
          messageCount: 2, firstMessage: "Archived conversation", allMessagesText: "Archived conversation reply" }
      ];
      const initial = await buildSessionCatalog({ gatewayInstanceRef: "gateway_metadata_test", key, listSessions: async () => infos,
        readMetadata: () => store.read() });
      const older = initial.sessions.find((item) => item.title === "Older pinned");
      const recent = initial.sessions.find((item) => item.title === "Recent archived");
      assert.ok(older && recent);
      const pinned = store.update(older.sessionRef, null, { pinned: true }, new Date("2026-08-14T06:00:00.000Z"));
      store.update(recent.sessionRef, null, { archived: true }, new Date("2026-08-14T06:01:00.000Z"));
      const merged = await buildSessionCatalog({ gatewayInstanceRef: "gateway_metadata_test", key, listSessions: async () => infos,
        readMetadata: () => store.read() });
      assert.equal(merged.sessions[0].sessionRef, older.sessionRef);
      assert.equal(merged.sessions[0].pinned, true);
      assert.equal(merged.sessions[0].sessionRevision === older.sessionRevision, false);
      assert.equal(merged.sessions.find((item) => item.sessionRef === recent.sessionRef).state, "archived");
      assert.equal(merged.sessions.find((item) => item.sessionRef === recent.sessionRef).composerAvailable, false);
      assert.ok(pinned.revision);
      assert.equal(JSON.stringify(merged).includes("/private/"), false);
      assert.equal(JSON.stringify(merged).includes("raw-a"), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the first user message for generic runtime session names", async () => {
    const key = Buffer.alloc(32, 11);
    const catalog = await buildSessionCatalog({ gatewayInstanceRef: "gateway_title_test", key, listSessions: async () => [{
      path: "/private/generic-session.jsonl", id: "generic", cwd: "/private/pi-company-platform", name: "Working",
      created: new Date("2026-08-14T07:00:00.000Z"), modified: new Date("2026-08-14T07:01:00.000Z"), messageCount: 2,
      firstMessage: "Refine the Source Changes review flow", allMessagesText: "Refine the Source Changes review flow\nReady"
    }] });
    assert.equal(catalog.sessions[0].title, "Refine the Source Changes review flow");
  });

  it("keeps fresh-session routing commands out of titles and previews", async () => {
    const key = Buffer.alloc(32, 13), command = "/fresh task Read task intake from .pi/task-inbox/2026-08-17-task.md. "
      + "Current session is near context limits; use a fresh governed session.";
    const catalog = await buildSessionCatalog({ gatewayInstanceRef: "gateway_fresh_title", key, listSessions: async () => [{
      path: "/private/fresh-session.jsonl", id: "fresh", cwd: "/private/pi-company-platform", name: `pi:task:${command}`,
      created: new Date("2026-08-17T12:33:38.000Z"), modified: new Date("2026-08-17T12:33:40.000Z"), messageCount: 1,
      firstMessage: command, allMessagesText: command
    }] });
    assert.equal(catalog.sessions[0].title, "Continued task");
    assert.equal(catalog.sessions[0].preview, "Continued in a fresh session");
    assert.equal(JSON.stringify(catalog).includes(".pi/task-inbox"), false);
  });

  it("uses a compact deterministic title without an extra model turn", async () => {
    const key = Buffer.alloc(32, 14), request = "Review the document workspace attachment preview and improve the session naming experience for operators";
    const catalog = await buildSessionCatalog({ gatewayInstanceRef: "gateway_compact_title", key, listSessions: async () => [{
      path: "/private/named-session.jsonl", id: "named", cwd: "/private/pi-company-platform", name: `pi:${request}`,
      created: new Date("2026-08-17T12:33:38.000Z"), modified: new Date("2026-08-17T12:33:40.000Z"), messageCount: 1,
      firstMessage: request, allMessagesText: request
    }] });
    assert.ok(catalog.sessions[0].title.length <= 73);
    assert.match(catalog.sessions[0].title, /…$/);
    assert.equal(catalog.sessions[0].title.includes(".pi/"), false);
  });

  it("keeps delegated and revived subagent sessions out of the user conversation catalog", async () => {
    const key = Buffer.alloc(32, 12), now = new Date("2026-08-17T07:15:00.000Z");
    const normal = { path: "/private/agent/sessions/project/main.jsonl", id: "main", cwd: "/private/project", name: "Document workspace",
      created: now, modified: now, messageCount: 2, firstMessage: "Add document support", allMessagesText: "Add document support\nReady" };
    const delegated = { ...normal, path: "/private/agent/sessions/subagent/96dfe478/run-0/session.jsonl", id: "child",
      name: "piagent-planner", firstMessage: "Task: You are a delegated subagent running from a fork of the parent session." };
    const revived = { ...normal, path: "/private/agent/sessions/project/revived.jsonl", id: "revived", parentSessionPath: normal.path,
      name: "subagent-piagent-planner-96dfe478-1", allMessagesText: `${normal.allMessagesText}\nTask: You are reviving a previous subagent conversation.` };
    const renamedHelper = { ...normal, path: "/private/agent/sessions/project/renamed-helper.jsonl", id: "renamed-helper",
      parentSessionPath: normal.path, name: "piagent-planner",
      allMessagesText: `${normal.allMessagesText}\nTask: You are a delegated subagent running from a fork of the parent session.` };
    const userFork = { ...normal, path: "/private/agent/sessions/project/user-fork.jsonl", id: "user-fork", parentSessionPath: normal.path,
      name: "Document workspace alternative" };
    const quotedMarker = { ...normal, path: "/private/agent/sessions/project/quoted-marker.jsonl", id: "quoted-marker",
      name: "Discuss subagent isolation", allMessagesText: `${normal.allMessagesText}\nTask: You are reviving a previous subagent conversation.` };
    const catalog = await buildSessionCatalog({ gatewayInstanceRef: "gateway_subagent_filter", key,
      listSessions: async () => [normal, delegated, revived, renamedHelper, userFork, quotedMarker] });
    assert.deepEqual(catalog.sessions.map((item) => item.title).sort(),
      ["Discuss subagent isolation", "Document workspace", "Document workspace alternative"]);
    assert.equal(catalog.page.total, 3);
    assert.equal(JSON.stringify(catalog).includes("delegated subagent"), false);
    assert.equal(catalog.sessions.some((item) => item.title === "piagent-planner"), false);
  });
});
