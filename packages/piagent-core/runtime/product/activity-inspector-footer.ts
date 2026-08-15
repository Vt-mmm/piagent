import type { CurrentActivity } from "./activity-inspector.ts";
import type { buildActivityInspector } from "./activity-inspector.ts";

type ActivityFooterTone = "brand" | "dim" | "cyan" | "green" | "yellow" | "red" | "magenta";

const ANSI: Record<ActivityFooterTone | "reset", string> = {
  brand: "\u001b[1;36m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  reset: "\u001b[0m"
};

function paint(value: string, tone: ActivityFooterTone, enabled: boolean): string {
  return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value;
}

function stateTone(state: string, current?: CurrentActivity): ActivityFooterTone {
  if (current?.status === "failed") return "red";
  if (current?.status === "blocked") return "yellow";
  if (current?.status === "completed") return "green";
  if (current?.status === "running") return "cyan";
  if (/failed|error|corrupt/i.test(state)) return "red";
  if (/blocked|repair|pending/i.test(state)) return "yellow";
  if (/completed|approved|pass/i.test(state)) return "green";
  if (/verify|review/i.test(state)) return "magenta";
  return state === "idle" ? "dim" : "cyan";
}

function contextTone(percent: number | null | undefined): ActivityFooterTone {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "dim";
  if (percent >= 80) return "red";
  if (percent >= 60) return "yellow";
  return "green";
}

function count(value: number, activeTone: ActivityFooterTone, enabled: boolean): string {
  return paint(String(value), value > 0 ? activeTone : "dim", enabled);
}

function target(value: string, maximum = 44): string {
  const single = String(value ?? "")
    .replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return single.length <= maximum ? single : `${single.slice(0, maximum - 1)}…`;
}

type ActivityInspectorView = Awaited<ReturnType<typeof buildActivityInspector>>;

function healthTone(view: ActivityInspectorView): ActivityFooterTone {
  if (view.safety.warnings > 0 || (view.context.current?.percent ?? 0) >= 80) return "red";
  if ((view.context.current?.percent ?? 0) >= 60) return "yellow";
  return "green";
}

export function formatActivityPanel(
  view: ActivityInspectorView,
  options: { color?: boolean } = {}
): string[] {
  const color = options.color === true;
  const current = view.state.current.at(-1);
  const context = view.context.current;
  const contextText = context?.percent === null || context?.percent === undefined ? "?" : `${context.percent.toFixed(0)}%`;
  const state = view.state.phase ?? view.state.outcome;
  const tone = stateTone(state, current);
  const stateIcon = state === "idle" ? "○" : tone === "red" ? "×" : tone === "yellow" ? "▲" : "●";
  const activity = current ? ` · ${paint(`${current.label}${current.target ? ` ${target(current.target)}` : ""}`, tone, color)}` : "";
  const scope = view.state.taskId ? "TASK" : "TREE";
  const mixed = view.files.lineStatsScope === "mixed-working-tree" ? ` · ${paint("mixed baseline", "yellow", color)}` : "";
  const commandTone = view.commands.failed > 0 ? "red" : view.commands.blocked > 0 ? "yellow" : view.commands.passed > 0 ? "green" : "dim";
  const commandIcon = view.commands.failed > 0 ? "×" : view.commands.blocked > 0 ? "!" : "›";
  const health = healthTone(view);
  const healthIcon = health === "red" ? "!" : health === "yellow" ? "▲" : "✓";
  const security = view.safety.warnings > 0
    ? `${count(view.safety.warnings, "red", color)} security warning${view.safety.warnings === 1 ? "" : "s"}`
    : paint("security clear", "green", color);

  return [
    `${paint(stateIcon, tone, color)} ${paint("PIAGENT", "brand", color)}    ${paint(state.toUpperCase(), tone, color)}${activity}`,
    `${paint("Δ", "cyan", color)} ${paint("CHANGES", "dim", color)}   ${paint(scope, "dim", color)} · ${paint(String(view.files.count), "cyan", color)} files · ${paint(String(view.files.testFiles.length), "magenta", color)} tests · ${paint(`+${view.files.additions}`, "green", color)} ${paint(`-${view.files.deletions}`, "red", color)}${mixed}`,
    `${paint(commandIcon, commandTone, color)} ${paint("COMMANDS", "dim", color)}  ${count(view.commands.passed, "green", color)} passed · ${count(view.commands.failed, "red", color)} failed · ${count(view.commands.blocked, "yellow", color)} blocked`,
    `${paint(healthIcon, health, color)} ${paint("HEALTH", "dim", color)}    ${security} · ${paint("context", "dim", color)} ${paint(contextText, contextTone(context?.percent), color)}`
  ];
}

export function formatActivityFooter(
  view: ActivityInspectorView,
  options: { color?: boolean } = {}
): string {
  const color = options.color === true;
  const current = view.state.current.at(-1);
  const context = view.context.current;
  const contextText = context?.percent === null || context?.percent === undefined ? "?" : `${context.percent.toFixed(0)}%`;
  const state = view.state.phase ?? view.state.outcome;
  const changeScope = view.state.taskId
    ? view.files.evidence === "exact-snapshot-delta" ? "Task Δ" : "Task files"
    : "Tree Δ";
  const tone = stateTone(state, current);
  const mixed = view.files.lineStatsScope === "mixed-working-tree"
    ? ` · ${paint("mixed baseline", "yellow", color)}`
    : "";
  const activityText = current ? `${current.label}${current.target ? ` ${target(current.target)}` : ""}` : "";
  const activity = activityText ? ` · ${paint(activityText, tone, color)}` : "";
  const files = `${paint(String(view.files.count), "cyan", color)}f/${paint(String(view.files.testFiles.length), "magenta", color)}t`;
  const additions = paint(`+${view.files.additions}`, "green", color);
  const deletions = paint(`-${view.files.deletions}`, "red", color);
  const passed = `${count(view.commands.passed, "green", color)}✓`;
  const failed = `${count(view.commands.failed, "red", color)}✗`;
  const blocked = `${count(view.commands.blocked, "yellow", color)}⊘`;
  const security = count(view.safety.warnings, "red", color);
  const contextValue = paint(contextText, contextTone(context?.percent), color);
  return `${paint("◆ Piagent", "brand", color)} ${paint(state, tone, color)}${activity} · ${paint(changeScope, "dim", color)} ${files} ${additions} ${deletions}${mixed} · ${paint("cmd", "dim", color)} ${passed} ${failed} ${blocked} · ${paint("sec", "dim", color)} ${security} · ${paint("ctx", "dim", color)} ${contextValue}`;
}
