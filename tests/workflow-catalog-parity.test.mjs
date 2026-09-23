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
    for (const id of WORKFLOW_IDS) assert.match(help, new RegExp(`/workflow ${id.replace(/-/g, "\\-")} `));
  });

  it("keeps browser workflow inventory on the Gateway's canonical WebUI projection", () => {
    const source = fs.readFileSync(path.join(repositoryRoot,
      "packages/piagent-webui/client/src/NewSessionPage.tsx"), "utf8");
    assert.match(source, /const workflows = options\?\.workflows \?\? \[\];/);
    assert.doesNotMatch(source, /piagent-core/);
    assert.doesNotMatch(source, /FALLBACK_WORKFLOWS|\{ id: "task", changeMode:/,
      "the client must not maintain a second workflow catalog");
    const apiSource = fs.readFileSync(path.join(repositoryRoot,
      "packages/piagent-webui/client/src/api.ts"), "utf8");
    assert.match(apiSource, /\n  workflows: Array<\{ id: Workflow; label: string;/,
      "the browser contract must require the Gateway's workflow projection");

    const composerSource = fs.readFileSync(path.join(repositoryRoot,
      "packages/piagent-webui/client/src/SessionHubApp.tsx"), "utf8");
    assert.match(composerSource, /setWorkflowOptions\(value\.workflows \?\? \[\]\)/);
    assert.match(composerSource, /\{workflowOptions\.map\(\(option\) => <MenuItem/);
    assert.doesNotMatch(composerSource, /piagent-core/);
    assert.doesNotMatch(composerSource, /<MenuItem value="(?:task|scout|be-to-fe|platform-improve)">/,
      "the in-session composer must not maintain a third workflow catalog");

    const gatewaySource = fs.readFileSync(path.join(repositoryRoot,
      "packages/piagent-webui/gateway/session-inspection-registry.ts"), "utf8");
    assert.match(gatewaySource, /profiles, workflows: WEBUI_WORKFLOW_OPTIONS/,
      "the Gateway must project the canonical catalog into browser-safe session options");
  });

  it("routes every canonical workflow and namespaced alias without semantic fallback", () => {
    for (const option of WORKFLOW_OPTIONS) {
      const request = `exercise ${option.id} behavior`;
      const terminal = `/workflow ${option.id} ${request}`;
      assert.equal(workflowIdFromInput(terminal), option.id);
      assert.equal(workflowIdFromInput(`/${option.id} ${request}`), option.id);
      assert.equal(extractTaskRequest(terminal), request);
      assert.equal(chooseFreshWorkflow(terminal, request), option.id);
      assert.equal(isPiagentWorkflowInput(terminal), true);
      assert.equal(buildWebUiWorkflowCommand(option.id, request), terminal);
      assert.equal(buildFreshCommand(repositoryRoot, option.id, terminal, "start clean"), `/fresh ${option.id} ${request}`);
      for (const alias of option.aliases) {
        assert.equal(workflowIdFromInput(`/workflow ${alias} ${request}`), option.id);
        assert.equal(extractTaskRequest(`/workflow ${alias} ${request}`), request);
      }
    }
    assert.equal(workflowIdFromInput("/workflow unknown request"), null);
    assert.equal(isPiagentWorkflowInput("/workflow unknown request"), false);
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

  it("preserves all workflows through the legacy session fresh ingress", async () => {
    const harness = sessionCommandHarness();
    const session = harness.commands.get("piagent-session");
    assert.ok(session);
    for (const workflow of WORKFLOW_IDS) {
      await session.handler(`fresh ${workflow} request for ${workflow}`, {});
    }
    assert.deepEqual(harness.fresh, WORKFLOW_IDS.map((workflow) => ({ workflow, request: `request for ${workflow}` })));

    await session.handler("new audit inspect policy", {});
    await session.handler("fresh investigate token accounting", {});
    assert.deepEqual(harness.fresh.slice(-2), [
      { workflow: "scout", request: "inspect policy" },
      { workflow: "task", request: "investigate token accounting" }
    ]);
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

  it("resolves help and fresh-session commands from the same catalog", async () => {
    const harness = commandHarness();
    await harness.commands.get("commands").handler("overview", harness.ctx);
    assert.match(harness.messages.at(-1).content, /\/fast/);
    await harness.commands.get("commands").handler("fast", harness.ctx);
    assert.match(harness.messages.at(-1).content, /\/fast status/);
    assert.match(harness.messages.at(-1).content, /zero-model-turn/);

    await harness.commands.get("workflow").handler("help", harness.ctx);
    assert.equal(harness.messages.at(-1).customType, "piagent-workflow-help");
    for (const id of WORKFLOW_IDS) assert.match(harness.messages.at(-1).content, new RegExp(`/workflow ${id.replace(/-/g, "\\-")} `));

    const fresh = harness.commands.get("fresh");
    const completions = await fresh.getArgumentCompletions("");
    assert.deepEqual(completions.map((item) => item.value), [...WORKFLOW_IDS, "help"]);
    await fresh.handler("help", harness.ctx);
    for (const id of WORKFLOW_IDS) assert.match(harness.messages.at(-1).content, new RegExp(`/fresh ${id.replace(/-/g, "\\-")} `));
    assert.equal(buildFreshCommand(repositoryRoot, "onboard", "/workflow onboard", "start clean"), "/fresh onboard");
    assert.deepEqual(FRESH_COMMAND_ACTIONS, [...WORKFLOW_IDS, "help"]);
    for (const id of WORKFLOW_IDS) assert.equal(FRESH_COMMAND_HELP.some((line) => line.startsWith(`/fresh ${id} `)), true);

    const sessionHarness = sessionCommandHarness();
    await sessionHarness.commands.get("piagent-session").handler("", {});
    assert.deepEqual(sessionHarness.menus[0].filter((option) => option.value.startsWith("fresh"))
      .map((option) => option.value), ["fresh"]);

    const freshCapabilityDocs = [
      "README.md",
      "packages/piagent-core/README.md",
      "docs/command-reference-vietnamese.md",
      "docs/operator-manual-vietnamese.md",
      "docs/quickstart-vietnamese.md",
      "docs/usage-observability.md",
      "docs/context-window-policy.md"
    ];
    for (const relative of freshCapabilityDocs) {
      const source = fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
      assert.match(source, /\/fresh help/, `${relative} must point to catalog-derived help`);
      assert.doesNotMatch(source, /\/fresh task\|scout\|be-to-fe/,
        `${relative} must not describe the three legacy fresh workflows as the full capability`);
    }
  });
});
