import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createContext,
  createPiHarness,
  writeRuntimeStubs
} from "./helpers/guard-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const RECOVERY_PROMPT = `The connection was interrupted and the previous send may have been delivered.
Continue the same request from durable session state without duplicating
already completed changes or messages. Re-check the original obligations,
finish any remaining in-scope work, verify it, and provide one terminal result.`;

function copyRuntime(root) {
  writeRuntimeStubs(root);
  fs.cpSync(path.join(repoRoot, "packages", "piagent-core"), path.join(root, "packages", "piagent-core"), { recursive: true });
  for (const directory of ["adapters", "packs", "evals", "scripts"]) {
    fs.cpSync(path.join(repoRoot, directory), path.join(root, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
}

function project(root) {
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi", "piagent-state", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(cwd, ".pi", "piagent-profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId: "uncertain-send-integration",
    displayName: "Uncertain Send Integration",
    mode: "node-typescript",
    protectedPaths: [],
    shellProtectedPaths: [],
    requiredContext: [],
    verifyCommands: { test: ["npm test"] },
    mcpCapabilities: ["filesystem-readonly", "filesystem-write", "shell"],
    permissionProfile: "workspace-write",
    runtimePolicy: {
      execPolicy: "enforce",
      contextBudget: "enforce",
      toolRegistry: "advisory",
      finalGate: "enforce"
    }
  }, null, 2)}\n`);
  execFileSync("git", ["init", "-q", cwd]);
  return cwd;
}

test("WebUI recovery binds the terminal contract instead of creating a read-only successor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-uncertain-runtime-"));
  try {
    copyRuntime(root);
    const packageRoot = path.join(root, "packages", "piagent-core");
    const guard = (await import(`${pathToFileURL(path.join(packageRoot, "extensions", "piagent-guard.ts")).href}?t=${Date.now()}`)).default;
    const { activeSessionTask, workingTreeSnapshot } = await import(pathToFileURL(path.join(packageRoot, "extensions", "task-state.js")).href);
    const { buildHandoffProjection, writeHandoffProjection } = await import(pathToFileURL(path.join(packageRoot, "runtime", "recovery", "handoff-projection.ts")).href);
    const cwd = project(root), sessionId = "uncertain-send-session";
    const ctx = createContext(cwd, { sessionId, sessionName: "UNCERTAIN-SEND" });
    const harness = createPiHarness({ activeTools: ["read", "bash", "apply_patch"] });
    guard(harness.pi);
    await harness.handlers.get("session_start")({}, ctx);

    const started = await harness.tools.get("piagent_task_start").execute("start-original", {
      taskId: "original-stream-task",
      summary: "Implement the original streaming parser request",
      riskLane: "normal",
      expectedOutput: "The parser implementation satisfies the original contract.",
      acceptanceCriteria: ["The original parser behavior is verified"],
      scope: ["src/**"]
    }, undefined, undefined, ctx);
    assert.equal(started.isError, undefined, started.content?.[0]?.text);
    await harness.tools.get("piagent_trace_record").execute("settle-original", {
      taskId: "original-stream-task",
      outcome: "blocked",
      friction: "The terminal receipt is being recovered after reconnect."
    }, undefined, undefined, ctx);
    const terminal = activeSessionTask(cwd, sessionId);
    assert.equal(terminal.trace.outcome, "blocked");
    writeHandoffProjection(cwd, buildHandoffProjection(cwd, terminal, {
      gate: { decision: "fail", missing: ["focused verification"], missingVerifyCommands: [] },
      currentDigests: workingTreeSnapshot(cwd)
    }));
    const taskFilesBefore = fs.readdirSync(path.join(cwd, ".pi", "piagent-state", "tasks")).sort();

    const inputResult = await harness.handlers.get("input")({ text: RECOVERY_PROMPT, source: "extension", images: [] }, ctx);
    assert.equal(inputResult?.action ?? "continue", "continue");
    const startResult = await harness.handlers.get("before_agent_start")({
      prompt: RECOVERY_PROMPT,
      systemPrompt: "Stable integration prompt",
      systemPromptOptions: { cwd, selectedTools: [...harness.activeTools] }
    }, ctx);

    assert.equal(startResult.message.details.runtimeIntakeStarted, false);
    assert.equal(startResult.message.details.runtimeTask.taskId, terminal.taskId);
    assert.equal(startResult.message.details.runtimeTask.taskRunId, terminal.taskRunId);
    assert.deepEqual(startResult.message.details.uncertainSendContinuation, {
      taskId: terminal.taskId,
      taskRunId: terminal.taskRunId,
      replacementTaskStarted: false
    });
    assert.match(startResult.message.content, /immediately preceding task already settled as blocked/i);
    assert.doesNotMatch(startResult.message.content, /Piagent runtime task:/);
    assert.equal(startResult.message.details.criterionContext, undefined);
    assert.deepEqual(fs.readdirSync(path.join(cwd, ".pi", "piagent-state", "tasks")).sort(), taskFilesBefore);
    assert.equal(activeSessionTask(cwd, sessionId).taskRunId, terminal.taskRunId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
