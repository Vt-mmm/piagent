import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import * as canonicalWorkflowCatalog from "../packages/piagent-core/extensions/workflow-catalog.ts";
import { registerPolicyTools } from "../packages/piagent-core/runtime/registration/policy-tools.ts";
import { FRESH_COMMAND_ACTIONS, FRESH_COMMAND_HELP } from "../packages/piagent-core/runtime/registration/operator-catalogs.ts";
import { registerSessionCommands } from "../packages/piagent-core/runtime/registration/session-commands.ts";
import { registerWorkflowCommands } from "../packages/piagent-core/runtime/registration/workflow-commands.ts";
import { parsePreflightWorkflow } from "../packages/piagent-core/runtime/registration/context-commands.ts";
import { buildContextPreflight } from "../packages/piagent-core/runtime/session/usage.ts";
import {
  WEBUI_WORKFLOW_IDS,
  WEBUI_WORKFLOW_OPTIONS,
  WORKFLOW_ALIASES,
  WORKFLOW_IDS,
  WORKFLOW_OPTIONS,
  buildWebUiWorkflowCommand,
  resolveWorkflowId,
  workflowCommandNames,
  workflowHelpLines,
  workflowOption
} from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import {
  buildFreshCommand,
  chooseFreshWorkflow,
  extractTaskRequest,
  isPiagentWorkflowInput,
  workflowIdFromInput
} from "../packages/piagent-core/runtime/workflows/input-routing.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function commandArgs(raw) {
  const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  const action = (tokens.shift() ?? "").toLowerCase();
  return { action, rest: tokens.join(" "), tokens };
}

function commandHarness() {
  const commands = new Map(), sent = [], messages = [], notices = [];
  const pi = { setSessionName() {} };
  registerWorkflowCommands(pi, {
    ONBOARDING_COMMAND_ACTIONS: ["status", "run", "profile", "setup", "tech", "help"],
    WORKFLOW_COMMAND_EXCLUSIONS: ["implement", "audit", "clarify", "platform", "onboard-project"],
    commandArgs,
    emitRuntimeMessage(_ctx, customType, content, details = {}) { messages.push({ customType, content, details }); },
    prefixCompletions(values, prefix) {
      const typed = String(prefix ?? "").trim().toLowerCase();
      return values.filter((value) => value.startsWith(typed)).map((value) => ({ value, label: value }));
    },
    registerRuntimeCommand(_pi, name, definition) { commands.set(name, definition); },
    selectRuntimeAction: async () => undefined,
    sendWorkflowFollowUp(value) { sent.push(value); },
    freshRequestParts(value) { return { request: String(value ?? "").trim(), sessionTitle: null }; },
    shortTaskLabel(value) { return String(value ?? "").trim().slice(0, 64) || "piagent task"; }
  });
  const ctx = { ui: { notify(message, level) { notices.push({ message, level }); } } };
  return { commands, ctx, sent, messages, notices };
}

function sessionCommandHarness() {
  const commands = new Map(), fresh = [], menus = [];
  const pi = {
    getThinkingLevel() { return "high"; },
    registerCommand(name, definition) { commands.set(name, definition); }
  };
  registerSessionCommands(pi, {
    commandArgs,
    emitRuntimeMessage() {},
    registerTaskPreflightCommand() {},
    async selectRuntimeAction(_ctx, _title, options) { menus.push(options); return undefined; },
    async startFreshWorkflow(workflow, request) { fresh.push({ workflow, request }); }
  });
  return { commands, fresh, menus };
}

describe("canonical workflow catalog parity", () => {
  it("keeps the runtime adapter on the exact surface-neutral catalog exports", () => {
    assert.equal(WORKFLOW_IDS, canonicalWorkflowCatalog.WORKFLOW_IDS);
    assert.equal(WORKFLOW_OPTIONS, canonicalWorkflowCatalog.WORKFLOW_OPTIONS);
    assert.equal(WORKFLOW_ALIASES, canonicalWorkflowCatalog.WORKFLOW_ALIASES);
    assert.equal(resolveWorkflowId, canonicalWorkflowCatalog.resolveWorkflowId);

    const catalogSource = fs.readFileSync(path.join(repositoryRoot,
      "packages/piagent-core/extensions/workflow-catalog.ts"), "utf8");
    assert.doesNotMatch(catalogSource, /(?:import|export)\s.+\sfrom\s+["']/,
      "the surface-neutral catalog must remain a dependency leaf");
  });

  it("keeps IDs, options, aliases, WebUI projection, prompts, and help bijective", () => {
    assert.equal(WORKFLOW_IDS.length, 10);
    assert.equal(new Set(WORKFLOW_IDS).size, WORKFLOW_IDS.length);
    assert.deepEqual(WORKFLOW_OPTIONS.map((option) => option.id), [...WORKFLOW_IDS]);
    assert.deepEqual([...WEBUI_WORKFLOW_IDS], [...WORKFLOW_IDS]);
    assert.deepEqual(WEBUI_WORKFLOW_OPTIONS.map((option) => option.id), [...WORKFLOW_IDS]);

    const aliases = WORKFLOW_OPTIONS.flatMap((option) => option.aliases);
    assert.equal(new Set(aliases).size, aliases.length, "one alias must resolve to exactly one workflow");
    assert.deepEqual(workflowCommandNames(), aliases);
    for (const option of WORKFLOW_OPTIONS) {
      assert.equal(resolveWorkflowId(option.id), option.id);
      assert.equal(workflowOption(option.id), option);
      assert.equal(option.aliases.includes(option.id), true, `${option.id} must be its own canonical alias`);
      for (const alias of option.aliases) assert.equal(WORKFLOW_ALIASES[alias], option.id);
    }

    const promptFiles = fs.readdirSync(path.join(repositoryRoot, "packages/piagent-core/prompts"))
      .filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, "")).sort();
    assert.deepEqual(promptFiles, WORKFLOW_IDS.filter((id) => id !== "onboard").sort(),
      "every model workflow has one prompt; onboard is the one runtime-built workflow");

    const help = workflowHelpLines().join("\n");
    for (const id of WORKFLOW_IDS) assert.ok(help.includes(`/workflow ${id} `));
  });

  // Workflow commands are retired: the browser offers no workflow picker, the
  // Gateway projects none, and no client file keeps its own workflow catalog.
  it("offers no workflow picker in the browser and keeps no client workflow catalog", () => {
    const read = (file) => fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    assert.match(read("packages/piagent-webui/gateway/session-inspection-registry.ts"), /workflows: \[\]/,
      "the Gateway projects no workflow options");
    for (const file of ["packages/piagent-webui/client/src/NewSessionPage.tsx", "packages/piagent-webui/client/src/SessionHubApp.tsx"]) {
      const source = read(file);
      assert.doesNotMatch(source, /workflowOptions\.map|FALLBACK_WORKFLOWS|<MenuItem value="(?:task|scout|be-to-fe|platform-improve)">/, file);
      assert.doesNotMatch(source, /piagent-core/, file);
    }
  });


  // A legacy client may still send a workflow with its message; the message is
  // sent exactly as written, never turned into a workflow command.
  it("never rewrites a message because a legacy client named a workflow", () => {
    for (const option of WORKFLOW_OPTIONS) {
      const request = `exercise ${option.id} behavior`;
      assert.equal(buildWebUiWorkflowCommand(option.id, request), request);
      assert.equal(buildWebUiWorkflowCommand(option.id, `  ${request}\n`), `  ${request}\n`, "whitespace is the member's");
    }
    assert.equal(buildWebUiWorkflowCommand(null, "/scout inspect auth"), "/scout inspect auth");
    assert.throws(() => buildWebUiWorkflowCommand("task", "   "), /workflow-request-empty/);
    assert.throws(() => buildWebUiWorkflowCommand("task", "a\0b"), /workflow-request-invalid/);
  });


  it("preserves all workflows through context preflight and its tool schema", () => {
    const snapshot = { cwd: repositoryRoot, mode: "interactive", model: "test", thinkingLevel: "medium",
      entries: { total: 0, branch: 0 }, exactTotals: { availableInCommand: false, howToRead: [] } };
    for (const option of WORKFLOW_OPTIONS) {
      assert.equal(parsePreflightWorkflow(`${option.id} compact`), option.id);
      for (const alias of option.aliases) assert.equal(parsePreflightWorkflow(`${alias} compact`), option.id);
      const preflight = buildContextPreflight(snapshot, option.id, 0);
      assert.equal(preflight.workflow, option.id);
      assert.equal(preflight.commands.includes(`/fresh ${option.id} <request>`), true);
    }
    assert.equal(parsePreflightWorkflow("compact unknown"), "task");
    assert.equal(parsePreflightWorkflow("fix audit logging"), "task",
      "workflow aliases in request prose must not override the first-argument contract");

    const registered = [];
    const Type = {
      Array: (value, options) => ({ type: "array", value, options }),
      Boolean: (options) => ({ type: "boolean", options }),
      Number: (options) => ({ type: "number", options }),
      Object: (properties) => ({ type: "object", properties }),
      Optional: (value) => value,
      String: (options) => ({ type: "string", options })
    };
    registerPolicyTools({ on() {}, registerTool(definition) { registered.push(definition); } }, {
      Type,
      StringEnum: (values) => ({ enum: [...values] }),
      registerPiagentTool(_pi, definition) { registered.push(definition); }
    });
    const schema = registered.find((tool) => tool.name === "piagent_context_preflight")?.parameters;
    assert.deepEqual(schema?.properties?.workflow?.enum, [...WORKFLOW_IDS]);
  });

  it("lets each message choose a different workflow in one session", async () => {
    const harness = commandHarness();
    const workflow = harness.commands.get("workflow");
    assert.ok(workflow);

    await workflow.handler("scout inspect auth", harness.ctx);
    await workflow.handler("task implement auth", harness.ctx);
    await workflow.handler("review inspect the resulting diff", harness.ctx);
    await workflow.handler("audit inspect token accounting", harness.ctx);
    await workflow.handler("commit", harness.ctx);

    assert.deepEqual(harness.sent, [
      "/scout inspect auth",
      "/task implement auth",
      "/review inspect the resulting diff",
      "/scout inspect token accounting",
      "/commit"
    ]);
    assert.deepEqual(harness.notices.map((notice) => notice.message), [
      "Workflow launched: scout",
      "Workflow launched: task",
      "Workflow launched: review",
      "Workflow launched: scout",
      "Workflow launched: commit"
    ]);
  });

  // /commands, /workflow and /fresh were retired with the task contract on
  // 2026-09-30; their help/fresh catalog test lives at 85f76db. The guard
  // registration test asserts none of them is published.
});
