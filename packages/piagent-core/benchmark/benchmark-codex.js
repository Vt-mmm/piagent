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

function controlledArgs(options, disabledFeatures) {
  const args = [
    "-m", codexModelName(options.model),
    "-c", `model_reasoning_effort=${JSON.stringify(codexThinkingEffort(options.thinking))}`
  ];
  if (options.codexMode === "controlled") {
    args.push("--ignore-user-config", "--ignore-rules");
    for (const feature of disabledFeatures) args.push("--disable", feature);
  }
  return args;
}

export function codexExecArgs({ workspace, options, disabledFeatures = [], persistent = false }) {
  const args = [
    "exec",
    "--json",
    ...(persistent ? [] : ["--ephemeral"]),
    "--color", "never",
    "-C", workspace,
    "-s", "workspace-write",
    ...controlledArgs(options, disabledFeatures)
  ];
  args.push("-");
  return args;
}

export function codexExecResumeArgs({ threadId, options, disabledFeatures = [] }) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(threadId)) {
    throw Object.assign(new Error("Codex CLI journey resume requires a valid thread id"), { exitCode: 1 });
  }
  return [
    "exec",
    "resume",
    "--json",
    ...controlledArgs(options, disabledFeatures),
    threadId,
    "-"
  ];
}
