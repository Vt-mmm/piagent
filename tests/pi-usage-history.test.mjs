import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "pi-usage-history.mjs");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-usage-history-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-history-"));
  temporaryRoots.add(root);
  const projectPath = path.join(root, "workspace");
  const otherProjectPath = path.join(root, "other");
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(otherProjectPath, { recursive: true });
  const project = fs.realpathSync(projectPath);
  const otherProject = fs.realpathSync(otherProjectPath);
  fs.mkdirSync(path.join(sessions, "project"), { recursive: true });
  fs.mkdirSync(path.join(sessions, "subagent", "abc", "run-0"), { recursive: true });
  fs.mkdirSync(path.join(sessions, "other"), { recursive: true });

  writeJsonl(path.join(sessions, "project", "main.jsonl"), [
    { type: "session", id: "main", timestamp: "2026-07-21T10:00:00.000Z", cwd: project },
    { type: "model_change", timestamp: "2026-07-21T10:00:01.000Z", provider: "openai", modelId: "gpt-5.5" },
    { type: "thinking_level_change", timestamp: "2026-07-21T10:00:02.000Z", thinkingLevel: "xhigh" },
    { type: "session_info", timestamp: "2026-07-21T10:00:03.000Z", name: "Main work" },
    {
      type: "message",
      timestamp: "2026-07-21T10:05:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Do the thing" }] }
    },
    {
      type: "message",
      timestamp: "2026-07-21T10:06:00.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "toolCall", id: "t1", name: "mcp", arguments: "{}" }],
        usage: usage(100, 20, 300, 0, 7, 420, 0.01)
      }
    },
    {
      type: "message",
      timestamp: "2026-07-21T10:07:00.000Z",
      message: { role: "toolResult", toolCallId: "t1", toolName: "mcp", content: [{ type: "text", text: "ok" }] }
    },
    {
      type: "message",
      timestamp: "2026-07-22T09:00:00.000Z",
      message: {
        role: "assistant",
        content: [],
        usage: usage(50, 5, 20, 10, 3, 85, 0.02)
      }
    }
  ]);

  writeJsonl(path.join(sessions, "subagent", "abc", "run-0", "session.jsonl"), [
    { type: "session", id: "sub", timestamp: "2026-07-22T10:00:00.000Z", cwd: project },
    { type: "session_info", timestamp: "2026-07-22T10:00:01.000Z", name: "Worker" },
    {
      type: "message",
      timestamp: "2026-07-22T10:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Scout" }] }
    },
    {
      type: "message",
      timestamp: "2026-07-22T10:02:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        content: [{ type: "toolCall", id: "r1", name: "read", arguments: "{}" }],
        usage: usage(10, 2, 30, 0, 1, 42, 0.03)
      }
    }
  ]);

  writeJsonl(path.join(sessions, "other", "other.jsonl"), [
    { type: "session", id: "other", timestamp: "2026-07-22T11:00:00.000Z", cwd: otherProject },
    {
      type: "message",
      timestamp: "2026-07-22T11:01:00.000Z",
      message: {
        role: "assistant",
        content: [],
        usage: usage(999, 999, 0, 0, 0, 1998, 9.99)
      }
    }
  ]);

  return { root, project, otherProject, sessions };
}

function usage(input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }
  };
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function runJson(args) {
  const result = spawnSync(process.execPath, [script, ...args, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("Pi usage history", () => {
  it("aggregates project sessions and subagents from finished JSONL files", () => {
    const fixture = makeFixture();
    const report = runJson([fixture.project, "--sessions-dir", fixture.sessions]);

    assert.equal(report.totals.sessions, 2);
    assert.equal(report.totals.mainSessions, 1);
    assert.equal(report.totals.subagentSessions, 1);
    assert.equal(report.totals.messages.user, 2);
    assert.equal(report.totals.messages.assistant, 3);
    assert.equal(report.totals.messages.toolCalls, 2);
    assert.deepEqual(report.totals.tokens, {
      input: 160,
      output: 27,
      cacheRead: 350,
      cacheWrite: 10,
      reasoning: 11,
      total: 547,
      cost: 0.06
    });
    assert.equal(report.projects[0].cwd, fixture.project);
  });

  it("can exclude subagent session files", () => {
    const fixture = makeFixture();
    const report = runJson([fixture.project, "--sessions-dir", fixture.sessions, "--no-subagents"]);

    assert.equal(report.totals.sessions, 1);
    assert.equal(report.totals.subagentSessions, 0);
    assert.equal(report.totals.tokens.total, 505);
    assert.equal(report.totals.tokens.cost, 0.03);
  });

  it("filters usage at message level for a date range", () => {
    const fixture = makeFixture();
    const report = runJson([
      fixture.project,
      "--sessions-dir", fixture.sessions,
      "--since", "2026-07-22",
      "--until", "2026-07-22"
    ]);

    assert.equal(report.totals.sessions, 2);
    assert.equal(report.totals.tokens.input, 60);
    assert.equal(report.totals.tokens.output, 7);
    assert.equal(report.totals.tokens.cacheRead, 50);
    assert.equal(report.totals.tokens.cacheWrite, 10);
    assert.equal(report.totals.tokens.total, 127);
    assert.equal(report.totals.tokens.cost, 0.05);
  });

  it("supports all-projects scope", () => {
    const fixture = makeFixture();
    const report = runJson(["--all-projects", "--sessions-dir", fixture.sessions]);

    assert.equal(report.totals.sessions, 3);
    assert.equal(report.projects.length, 2);
    assert.equal(report.totals.tokens.total, 2545);
  });
});
