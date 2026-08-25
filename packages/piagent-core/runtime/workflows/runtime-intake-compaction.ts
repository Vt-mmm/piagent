import { RUNTIME_INTAKE_MESSAGE_MAX_CHARS } from "../runtime-limits.ts";
import { verifierCommandBoundsError } from "../../extensions/verification-intelligence.js";

const COMPACTION_MARKER = "[Piagent intake guidance compacted; the complete operator request and durable Task Contract remain authoritative.]";
const MAX_EXACT_FINAL_OUTPUT_LINE_CHARS = 512;

function edgeBounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = " … ";
  const available = maximum - marker.length;
  const head = Math.floor(available * 0.6);
  return `${value.slice(0, head).trimEnd()}${marker}${value.slice(-(available - head)).trimStart()}`;
}

function legacyHeadTail(text: string): string {
  const marker = `\n\n${COMPACTION_MARKER}\n\n`;
  const available = RUNTIME_INTAKE_MESSAGE_MAX_CHARS - marker.length;
  const head = Math.floor(available * 0.58);
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-(available - head)).trimStart()}`;
}

function minimalCriticalProof(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const tags = [...new Set((lines.join("\n").match(/\[(?:criterion-[0-9]{2}|fallback)(?::[^\]]+)?\]/g) ?? []).map((tag) => {
    const identity = tag.match(/^\[(criterion-[0-9]{2}|fallback)/)?.[1] ?? "fallback";
    if (tag.includes(":fallback")) return `[${identity}:fallback]`;
    if (tag.includes(":")) return `[${identity}:candidate]`;
    return `[${identity}]`;
  }))].slice(0, 12);
  return [
    "Critical behavioral proof:",
    `- ${tags.join("")} Prove every tagged observable clause with linked durable live assertions; the generic verifier alone is insufficient.`,
    "Fallback tags require a focused test. Run proof after final mutation and before exact verifiers; prose or transient probes are insufficient."
  ];
}

function minimalExecutionMap(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const rows = lines.slice(1, 13).map((line) => {
    const criterion = line.match(/^-\s+(criterion-[0-9]{2})\b/)?.[1];
    const target = line.match(/^-\s+criterion-[0-9]{2}\s+(\S+)/)?.[1];
    const after = line.match(/\bafter=(\S+)/)?.[1];
    if (!criterion) return `- ${edgeBounded(line.replace(/^-\s*/, ""), 72)}`;
    return `- ${criterion}${target ? ` ${edgeBounded(target, 38)}` : ""}${after ? ` after=${edgeBounded(after, 18)}` : ""}`;
  });
  return [lines[0], ...rows];
}

function identityOnlyExecutionMap(lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [
    lines[0],
    ...lines.slice(1, 13).map((line, index) => `- ${line.match(/\bcriterion-[0-9]{2}\b/)?.[0] ?? `criterion-${String(index + 1).padStart(2, "0")}`}`)
  ];
}

function structuredCompaction(text: string): string | undefined {
  const lines = text.split("\n");
  const critical = lines.indexOf("Critical behavioral proof:");
  const exactOutput = lines.findIndex((line) => line.startsWith("Exact final-output contract:"));
  const exact = lines.indexOf("Exact verifier commands:");
  const execution = lines.indexOf("Execution map (planning only):");
  const reuse = lines.findIndex((line, index) => index > execution && line.startsWith("Use runtime-delivered source;"));
  if (!(exact >= 0 && execution > exact && reuse > execution)) return undefined;
  const publicContract = critical >= 0
    ? lines.findIndex((line, index) => index > critical && index < exact && line === "Existing public contract:")
    : -1;
  const criticalLines = critical >= 0 ? lines.slice(critical, publicContract > critical ? publicContract : exact) : [];
  const exactOutputLines = exactOutput >= 0 && exactOutput < exact ? [lines[exactOutput]] : [];
  const exactLines = lines.slice(exact, execution);
  const executionLines = lines.slice(execution, reuse);
  const prefixEnd = [critical, exactOutput, exact].filter((index) => index >= 0).sort((left, right) => left - right)[0];
  const prefix = lines.slice(0, prefixEnd).slice(0, 3);
  const finalGuidance = [...lines].reverse().find(Boolean) ?? "";
  const compose = (proof: string[], map: string[], compactPrefix = false) => [
    ...(compactPrefix ? prefix.map((line) => edgeBounded(line, 360)) : prefix),
    COMPACTION_MARKER,
    ...proof,
    ...exactOutputLines,
    ...displayExactLines,
    ...map,
    lines[reuse],
    finalGuidance
  ].filter(Boolean).join("\n");
  const presentedCommands = exactLines.slice(1)
    .map((line) => line.match(/^Verifier\s+\d+\s+\(run as an exact standalone shell command\): (.*)$/)?.[1] ?? line)
    .filter((command) => command.trim());
  const displayExactLines = [
    "Exact verifier commands:",
    ...presentedCommands.map((command, index) => `Verifier ${index + 1} (run as an exact standalone shell command): ${command}`)
  ];
  const verifierError = verifierCommandBoundsError(presentedCommands);
  if (verifierError) return [
    ...prefix.slice(0, 2).map((line) => edgeBounded(line, 220)),
    COMPACTION_MARKER,
    ...exactOutputLines.map((line) => edgeBounded(line, 260)),
    "Exact verifier commands:",
    `Runtime intake refused: ${verifierError} No verifier was truncated or accepted as evidence; correct the profile and restart the task.`,
    ...minimalExecutionMap(executionLines),
    edgeBounded(lines[reuse], 220),
    "Stop this task until a bounded exact verifier is configured."
  ].filter(Boolean).join("\n");
  if (exactOutputLines.some((line) => line.length > MAX_EXACT_FINAL_OUTPUT_LINE_CHARS)) return [
    ...prefix.slice(0, 2).map((line) => edgeBounded(line, 220)),
    COMPACTION_MARKER,
    "Exact final-output contract:",
    `Runtime intake refused: the mandatory exact final-output guidance exceeds ${MAX_EXACT_FINAL_OUTPUT_LINE_CHARS} characters and cannot be carried verbatim. Shorten the directive and restart the task.`,
    ...displayExactLines,
    ...identityOnlyExecutionMap(executionLines).slice(0, 9),
    "Stop this task until the exact final-output contract can be injected without mutation."
  ].filter(Boolean).join("\n");
  const preferred = compose(criticalLines, executionLines);
  if (preferred.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) return preferred;
  const minimal = compose(minimalCriticalProof(criticalLines), minimalExecutionMap(executionLines), true);
  if (minimal.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) return minimal;
  const guaranteed = [
    ...prefix.slice(0, 2).map((line) => edgeBounded(line, 220)),
    COMPACTION_MARKER,
    ...minimalCriticalProof(criticalLines),
    ...exactOutputLines,
    ...displayExactLines,
    ...minimalExecutionMap(executionLines),
    edgeBounded(lines[reuse], 220),
    edgeBounded(finalGuidance, 220)
  ].filter(Boolean).join("\n");
  if (guaranteed.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) return guaranteed;
  const final = [
    ...prefix.slice(0, 1).map((line) => edgeBounded(line, 120)),
    COMPACTION_MARKER,
    ...minimalCriticalProof(criticalLines),
    ...exactOutputLines,
    ...displayExactLines,
    ...identityOnlyExecutionMap(executionLines),
    edgeBounded(lines[reuse], 120),
    edgeBounded(finalGuidance, 120)
  ].filter(Boolean).join("\n");
  if (final.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) return final;
  const absoluteFallback = [
    COMPACTION_MARKER,
    ...minimalCriticalProof(criticalLines).slice(0, 2).map((line) => edgeBounded(line, 420)),
    ...exactOutputLines,
    ...displayExactLines,
    ...identityOnlyExecutionMap(executionLines).slice(0, 9),
    edgeBounded(lines[reuse], 100),
    edgeBounded(finalGuidance, 100)
  ].filter(Boolean).join("\n");
  if (absoluteFallback.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) return absoluteFallback;
  return [
    COMPACTION_MARKER,
    ...exactOutputLines,
    ...displayExactLines,
    "Runtime intake refused: mandatory exact output and verifier guidance cannot fit the bounded provider intake without mutation. Shorten the configured contract and restart the task.",
    "Stop this task; do not infer or reconstruct omitted acceptance details."
  ].filter(Boolean).join("\n");
}

export function boundedRuntimeIntakeMessage(value: string): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  const structured = structuredCompaction(text);
  if (text.length <= RUNTIME_INTAKE_MESSAGE_MAX_CHARS) {
    return structured?.includes("Runtime intake refused:") ? structured : text;
  }
  return structured ?? legacyHeadTail(text);
}
