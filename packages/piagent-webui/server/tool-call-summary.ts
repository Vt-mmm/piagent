import os from "node:os";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";

// What a coding-agent timeline shows for one tool call: the kind of action,
// its target (project-relative path, command, query or URL), an edit's diff
// and a bounded result preview. Every string is ANSI-stripped and redacted;
// raw arguments and results never leave the server.
export type ToolKind = "read" | "write" | "edit" | "command" | "search" | "list" | "web-search" | "web-fetch"
  | "subagent" | "network" | "git" | "plan" | "other";
export type ToolSummary = { kind: ToolKind; target: string | null; detail: string | null };
export type ToolChange = { added: number; removed: number; preview: string; truncated: boolean };
export type ToolResult = { text: string; truncated: boolean; isError: boolean };
export type TurnUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TARGET_CHARS = 400, DETAIL_CHARS = 400, PREVIEW_LINES = 80, PREVIEW_CHARS = 6_000, RESULT_LINES = 60, RESULT_CHARS = 4_000;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = redactedWhole(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
// Redaction needs the whole text: a private key is recognised only while its
// lines are together, so file contents and edit texts are redacted before they
// are split into preview rows.
function redactedWhole(value: unknown): string {
  return redactSensitiveText(String(value ?? "").replace(ANSI, "").replace(CONTROL, " ")).text;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function pick(args: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (args[key] !== undefined && args[key] !== null && args[key] !== "") return args[key];
  return undefined;
}
// Paths inside the project are shown relative to it; anything else only by
// its file name, so folders outside the project never reach the browser.
export function displayPath(value: unknown, cwd?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (!path.isAbsolute(raw)) return raw.split(/[\\/]/).includes("..") ? clean(path.basename(raw), TARGET_CHARS) : clean(raw, TARGET_CHARS);
  const relative = cwd ? path.relative(cwd, raw) : "";
  return cwd && !relative.startsWith("..") && !path.isAbsolute(relative) ? clean(relative || ".", TARGET_CHARS) : clean(path.basename(raw), TARGET_CHARS);
}
// A command as run in the project: the project folder reads "." and the home
// folder "~".
function displayCommand(value: unknown, cwd?: string): string | null {
  if (typeof value !== "string") return null;
  let shown = value;
  if (cwd && cwd.length > 1) shown = shown.split(cwd).join(".");
  const home = os.homedir();
  if (home.length > 1) shown = shown.split(home).join("~");
  return clean(shown, TARGET_CHARS);
}
// A multi-line command (a heredoc, a script) reads by its first line; the
// whole command, bounded, opens in the step's body.
function commandParts(value: unknown, cwd?: string): { target: string | null; script: string | null } {
  const full = displayCommand(value, cwd), rows = full ? full.split("\n").filter((row) => row.trim()) : [];
  return rows.length > 1 ? { target: `${rows[0].trim().slice(0, TARGET_CHARS - 2)} …`, script: full } : { target: full, script: null };
}
const lines = (text: string) => text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");

function bounded(rows: string[], removed: number, added: number): ToolChange {
  let preview = "", count = 0, truncated = false;
  for (const row of rows) {
    const safe = (clean(row, 400) ?? row.slice(0, 1)).replace(/\n/g, " ");
    if (count >= PREVIEW_LINES || preview.length + safe.length + 1 > PREVIEW_CHARS) { truncated = true; break; }
    preview += (count ? "\n" : "") + safe; count += 1;
  }
  return { added, removed, preview, truncated };
}
// Old and new text of each edit, trimmed to the changed lines plus two lines
// of context: enough to read the change without reproducing the file.
function editChange(edits: Array<{ oldText?: unknown; newText?: unknown }>): ToolChange {
  const rows: string[] = []; let added = 0, removed = 0;
  for (const edit of edits.slice(0, 20)) {
    const before = lines(redactedWhole(edit.oldText)), after = lines(redactedWhole(edit.newText));
    let head = 0; while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0; while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
    const gone = before.slice(head, before.length - tail), come = after.slice(head, after.length - tail);
    removed += gone.length; added += come.length;
    if (rows.length) rows.push("@@");
    for (const row of before.slice(Math.max(0, head - 2), head)) rows.push(` ${row}`);
    for (const row of gone) rows.push(`-${row}`);
    for (const row of come) rows.push(`+${row}`);
    for (const row of before.slice(before.length - tail, Math.min(before.length, before.length - tail + 2))) rows.push(` ${row}`);
  }
  return bounded(rows, removed, added);
}

// A patch in the apply_patch format: the files it touches (from its
// "*** Add/Update/Delete File:" headers) and its +/- body lines, redacted as a
// whole like an edit. "write" when it only adds files.
function patchChange(value: unknown, cwd?: string): { summary: ToolSummary; change: ToolChange } {
  const text = redactedWhole(value), rows: string[] = [], files: string[] = []; let added = 0, removed = 0, onlyAdds = true;
  for (const row of lines(text)) {
    const header = row.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) { files.push(header[2].trim()); if (header[1] !== "Add") onlyAdds = false; if (rows.length) rows.push("@@"); continue; }
    if (/^\*\*\* (Begin|End) Patch$|^\*\*\* Move to: /.test(row)) continue;
    if (row.startsWith("@@")) { if (rows.length && rows.at(-1) !== "@@") rows.push("@@"); continue; }
    if (row.startsWith("+")) added += 1; else if (row.startsWith("-")) removed += 1;
    rows.push(row);
  }
  const first = displayPath(files[0], cwd), more = files.length - 1;
  return { summary: { kind: files.length && onlyAdds ? "write" : "edit", target: first && more > 0 ? `${first} +${more}` : first, detail: null },
    change: bounded(rows, removed, added) };
}

const ALIASES: Record<string, string> = { read_file: "read", view: "read", cat: "read", write_file: "write", create_file: "write",
  edit_file: "edit", str_replace: "edit", str_replace_editor: "edit", shell: "bash", exec: "bash", run: "bash", terminal: "bash", run_experiment: "bash",
  glob: "find", search: "grep", search_files: "grep", list: "ls", list_files: "ls", list_dir: "ls" };

export function summarizeToolCall(name: unknown, input: unknown, cwd?: string): { summary: ToolSummary; change?: ToolChange } {
  const raw = String(name ?? "").toLowerCase(), tool = ALIASES[raw] ?? raw, args = record(input);
  const file = pick(args, ["path", "file_path", "filePath", "file"]);
  switch (tool) {
    case "read": {
      const offset = Number(args.offset), limit = Number(args.limit);
      const detail = Number.isInteger(offset) && offset > 0 ? `${offset}${Number.isInteger(limit) && limit > 0 ? `–${offset + limit - 1}` : "+"}` : null;
      return { summary: { kind: "read", target: displayPath(file, cwd), detail } };
    }
    case "write": {
      const content = lines(redactedWhole(args.content));
      return { summary: { kind: "write", target: displayPath(file, cwd), detail: null },
        change: bounded(content.map((row) => `+${row}`), 0, content.length) };
    }
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits as Array<{ oldText?: unknown; newText?: unknown }>
        : [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }];
      return { summary: { kind: "edit", target: displayPath(file, cwd), detail: null }, change: editChange(edits) };
    }
    case "apply_patch": return patchChange(pick(args, ["patch", "input"]), cwd);
    case "bash": {
      const command = commandParts(args.command, cwd);
      return { summary: { kind: "command", target: command.target, detail: command.script } };
    }
    case "run_with_network":
      return { summary: { kind: "network", target: commandParts(args.command, cwd).target, detail: clean(args.reason, DETAIL_CHARS) } };
    case "grep": case "find": {
      const where = [displayPath(args.path, cwd), clean(args.glob, 120)].filter(Boolean).join(" · ");
      return { summary: { kind: "search", target: clean(args.pattern, TARGET_CHARS), detail: where || null } };
    }
    case "ls": return { summary: { kind: "list", target: displayPath(file ?? ".", cwd), detail: null } };
    case "web_search": return { summary: { kind: "web-search", target: clean(args.query, TARGET_CHARS), detail: null } };
    case "web_fetch": return { summary: { kind: "web-fetch", target: clean(args.url, TARGET_CHARS), detail: null } };
    case "delegate": case "subagent":
      return { summary: { kind: "subagent", target: clean(pick(args, ["role", "agent", "name"]), 40), detail: clean(args.task, 200) } };
    case "fetch_origin": return { summary: { kind: "git", target: clean(pick(args, ["remote", "branch", "ref"]) ?? "origin", 120), detail: null } };
    case "update_plan": {
      // The checklist's progress, and the step being worked on.
      const steps = Array.isArray(args.plan) ? (args.plan as Array<{ step?: unknown; status?: unknown }>) : [];
      const done = steps.filter((p) => p?.status === "completed").length, current = steps.find((p) => p?.status === "in_progress");
      return { summary: { kind: "plan", target: `${done}/${steps.length}`, detail: clean(current?.step, 200) } };
    }
    default: {
      const first = Object.values(args).find((value) => typeof value === "string" && value.trim()) as string | undefined;
      const target = first && /[\\/]/.test(first) ? displayPath(first, cwd) : clean(first, 200);
      return { summary: { kind: "other", target, detail: null } };
    }
  }
}

export function toolResultPreview(message: any): ToolResult {
  const text = typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
    ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
  const all = lines(clean(text, 1_000_000) ?? ""), kept = all.slice(0, RESULT_LINES).join("\n");
  return { text: kept.slice(0, RESULT_CHARS), truncated: all.length > RESULT_LINES || kept.length > RESULT_CHARS, isError: Boolean(message?.isError) };
}

export function turnUsage(message: any): TurnUsage | null {
  const usage = record(message?.usage);
  const count = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(10_000_000_000, Math.round(Number(value))) : 0;
  const value = { inputTokens: count(usage.input), outputTokens: count(usage.output), cacheReadTokens: count(usage.cacheRead),
    cacheWriteTokens: count(usage.cacheWrite), totalTokens: count(usage.totalTokens) };
  if (!value.totalTokens) value.totalTokens = Math.min(10_000_000_000, value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens);
  return value.totalTokens ? value : null;
}

export function modelLabel(message: any): string | null {
  const model = typeof message?.model === "string" ? message.model.replace(/[^A-Za-z0-9._:@/-]/g, "").slice(0, 120) : "";
  return model || null;
}
