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
  return thinking === "off" ? "none" : thinking;
}

export function codexExecArgs({ workspace, options, disabledFeatures = [] }) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--color", "never",
    "-C", workspace,
    "-s", "workspace-write",
    "-m", codexModelName(options.model),
    "-c", `model_reasoning_effort=${JSON.stringify(codexThinkingEffort(options.thinking))}`
  ];
  if (options.codexMode === "controlled") {
    args.push("--ignore-user-config", "--ignore-rules");
    for (const feature of disabledFeatures) args.push("--disable", feature);
  }
  args.push("-");
  return args;
}
