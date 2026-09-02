import path from "node:path";
import { types } from "node:util";

export const CODEX_SCOPED_BROKER_TOOLS = Object.freeze(["scoped_read", "scoped_write_document", "scoped_verify"]);
export const CODEX_SCOPED_BROKER_DISABLED_FEATURES = Object.freeze([
  "shell_tool", "unified_exec", "view_image", "apps", "plugins", "remote_plugin", "multi_agent",
  "multi_agent_v2", "code_mode", "code_mode_host", "browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "image_generation", "in_app_browser", "hooks",
  "skill_search", "skill_mcp_dependency_install", "memories", "goals", "tool_suggest",
  "workspace_dependencies"
]);

export function codexScopedBrokerOverrides(value = {}) {
  const names = ["nodeCommand", "brokerScript", "brokerConfigPath"];
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw Object.assign(new Error("Codex scoped broker configuration must be an exact plain object"), { exitCode: 1 });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length
    || names.some(name => !descriptors[name]?.enumerable || !Object.hasOwn(descriptors[name], "value"))) {
    throw Object.assign(new Error("Codex scoped broker configuration must be an exact plain object"), { exitCode: 1 });
  }
  const nodeCommand = descriptors.nodeCommand.value, brokerScript = descriptors.brokerScript.value;
  const brokerConfigPath = descriptors.brokerConfigPath.value;
  for (const value of [nodeCommand, brokerScript, brokerConfigPath]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
      throw Object.assign(new Error("Codex scoped broker paths must be canonical absolute paths"), { exitCode: 1 });
    }
  }
  return [
    "-c", 'tools.surface="external_mcp_only"',
    "-c", "tools.update_plan.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "include_permissions_instructions=false",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "project_doc_fallback_filenames=[]",
    "-c", "skills.include_instructions=false",
    "-c", "skills.bundled.enabled=false",
    "-c", "memories.generate_memories=false",
    "-c", "memories.use_memories=false",
    "-c", `mcp_servers.piagent_broker.command=${JSON.stringify(nodeCommand)}`,
    "-c", `mcp_servers.piagent_broker.args=${JSON.stringify([brokerScript, "--serve-config", brokerConfigPath])}`,
    "-c", `mcp_servers.piagent_broker.env={HOME=${JSON.stringify(path.dirname(brokerConfigPath))}}`,
    "-c", "mcp_servers.piagent_broker.env_vars=[]",
    "-c", "mcp_servers.piagent_broker.enabled=true",
    "-c", "mcp_servers.piagent_broker.required=true",
    "-c", "mcp_servers.piagent_broker.supports_parallel_tool_calls=false",
    "-c", 'mcp_servers.piagent_broker.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.piagent_broker.startup_timeout_sec=10",
    "-c", "mcp_servers.piagent_broker.tool_timeout_sec=60",
    "-c", `mcp_servers.piagent_broker.enabled_tools=${JSON.stringify(CODEX_SCOPED_BROKER_TOOLS)}`
  ];
}

export function codexModelName(model) {
  const value = String(model ?? "").trim();
  if (!value) throw Object.assign(new Error("Codex CLI comparisons require --model"), { exitCode: 1 });
  const separator = value.indexOf("/");
  const resolved = separator >= 0 ? value.slice(separator + 1) : value;
  if (!resolved || resolved.includes("/")) throw Object.assign(new Error(`Cannot map --model ${value} to a Codex CLI model id`), { exitCode: 1 });
  return resolved;
}

export function codexThinkingEffort(thinking) {
  if (!thinking) throw Object.assign(new Error("Codex CLI comparisons require --thinking"), { exitCode: 1 });
  if (thinking === "off") return "none";
  if (thinking === "minimal") return "low";
  return thinking;
}

function controlledArgs(options, disabledFeatures, scopedBroker) {
  const args = [
    "-m", codexModelName(options.model),
    "-c", `model_reasoning_effort=${JSON.stringify(codexThinkingEffort(options.thinking))}`
  ];
  if (options.serviceTier === "fast") {
    args.push("-c", "service_tier=\"fast\"", "--enable", "fast_mode");
  } else if (options.serviceTier === "default") {
    args.push("-c", "service_tier=\"default\"", "--disable", "fast_mode");
  }
  if (options.codexMode === "controlled") {
    // A controlled benchmark must fail before provider execution when an
    // override is unknown to the pinned Codex executable. This makes the
    // actual argv a usable configuration receipt instead of silently allowing
    // a misspelled or removed service-tier option to fall back to defaults.
    args.push("--strict-config", "--ignore-user-config", "--ignore-rules");
    const requiredDisabled = scopedBroker ? CODEX_SCOPED_BROKER_DISABLED_FEATURES : [];
    for (const feature of new Set([...disabledFeatures, ...requiredDisabled])) args.push("--disable", feature);
  }
  if (scopedBroker) {
    if (options.codexMode !== "controlled") throw Object.assign(new Error("Codex scoped broker requires controlled mode"), { exitCode: 1 });
    args.push(...codexScopedBrokerOverrides(scopedBroker));
  }
  return args;
}

export function codexExecArgs({ workspace, options, disabledFeatures = [], persistent = false, scopedBroker }) {
  const args = [
    "exec",
    "--json",
    ...(persistent ? [] : ["--ephemeral"]),
    "--color", "never",
    "-C", workspace,
    "-s", "workspace-write",
    ...controlledArgs(options, disabledFeatures, scopedBroker)
  ];
  args.push("-");
  return args;
}

export function codexExecResumeArgs({ threadId, options, disabledFeatures = [], scopedBroker }) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(threadId)) {
    throw Object.assign(new Error("Codex CLI journey resume requires a valid thread id"), { exitCode: 1 });
  }
  return [
    "exec",
    "resume",
    "--json",
    ...controlledArgs(options, disabledFeatures, scopedBroker),
    threadId,
    "-"
  ];
}
