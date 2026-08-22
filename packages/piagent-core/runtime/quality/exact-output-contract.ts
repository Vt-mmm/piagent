import fs from "node:fs";
import path from "node:path";

import { durableContextEvidenceEntries } from "../../extensions/context-evidence.js";
import type { TaskContract } from "../../extensions/guard-types.js";

const MAX_EVIDENCE_BYTES = 256 * 1024;
const EXACT_OUTPUT_TEMPLATE = /\b([A-Z][A-Z0-9_]{2,63})\s*=\s*<([a-z][a-z0-9_-]{1,31})>/g;

export type ExactOutputContractEvaluation = {
  applicable: boolean;
  passed: boolean;
  key?: string;
  expectedLines: string[];
  evidencePaths: string[];
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactOutputDirective(text: string): { key: string; placeholder: string } | undefined {
  const value = String(text ?? "");
  for (const match of value.matchAll(EXACT_OUTPUT_TEMPLATE)) {
    const nearby = value.slice(Math.max(0, match.index! - 180), Math.min(value.length, match.index! + match[0].length + 180));
    if (/\b(?:finish|end|last)\b[\s\S]{0,180}\b(?:response|answer|output|with|line)\b/i.test(nearby)) {
      return { key: match[1], placeholder: match[2] };
    }
  }
  return undefined;
}

function safeObservedFile(cwd: string, candidate: string): { path: string; text: string } | undefined {
  try {
    const absolute = path.resolve(cwd, candidate);
    const relative = path.relative(cwd, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) return undefined;
    return { path: relative.split(path.sep).join("/"), text: fs.readFileSync(absolute, "utf8") };
  } catch {
    return undefined;
  }
}

function valuesForKey(key: string, text: string): string[] {
  const keyPattern = key.split(/_+/).filter(Boolean).map(escapeRegex).join("[\\s_-]*");
  if (!keyPattern) return [];
  const assignment = new RegExp(String.raw`\b${keyPattern}\b\s*[:=]\s*["']?([a-z0-9][a-z0-9_.:/-]{0,255})`, "gi");
  return [...text.matchAll(assignment)].map((match) => match[1]);
}

export function exactFinalOutputGuidance(taskText: string): string[] {
  const directive = exactOutputDirective(taskText);
  if (!directive) return [];
  return [
    `Exact final-output contract: make ${directive.key}=<${directive.placeholder}> the last non-empty response line. Copy the complete value verbatim from observed in-scope evidence and self-check every character before handoff.`
  ];
}

export function evaluateExactFinalOutputContract(
  task: Pick<TaskContract, "summary" | "expectedOutput" | "acceptanceCriteria" | "contextManifest">,
  responseText: string,
  cwd: string
): ExactOutputContractEvaluation {
  const directive = exactOutputDirective([
    task.summary,
    task.expectedOutput,
    ...(task.acceptanceCriteria ?? [])
  ].filter(Boolean).join("\n"));
  if (!directive) return { applicable: false, passed: true, expectedLines: [], evidencePaths: [] };

  const evidencePaths: string[] = [];
  const observedValues = new Set<string>();
  for (const entry of durableContextEvidenceEntries(task)) {
    const observed = safeObservedFile(cwd, entry.path);
    if (!observed) continue;
    const values = valuesForKey(directive.key, observed.text);
    if (values.length === 0) continue;
    evidencePaths.push(observed.path);
    for (const value of values) observedValues.add(value);
  }
  if (observedValues.size === 0) {
    return { applicable: false, passed: true, key: directive.key, expectedLines: [], evidencePaths: [] };
  }

  const expectedLines = [...observedValues].sort().map((value) => `${directive.key}=${value}`);
  const finalLine = String(responseText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return {
    applicable: true,
    passed: expectedLines.includes(finalLine),
    key: directive.key,
    expectedLines,
    evidencePaths: [...new Set(evidencePaths)].sort()
  };
}
