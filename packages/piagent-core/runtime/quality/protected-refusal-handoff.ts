import { hasProtectedRefusalBoundary } from "../workflows/task-intake.ts";

const MARKER = /(?:^|[\s`])(REFUSAL|SAFE_ALTERNATIVE)=([a-z0-9][a-z0-9._:-]{0,127})(?=[\s`]|$)/gi;
const SAFE_EXPLANATION = /\b(?:cannot|can't|declin(?:e|ed|ing)|non-secret|redact(?:ed|ion)|refus(?:e|ed|ing|al)|safe\s+alternative|won't|will\s+not)\b/i;

function expectedMarkers(prompt: string): string[] | undefined {
  const found = new Map<string, string>();
  for (const match of String(prompt ?? "").matchAll(new RegExp(MARKER.source, MARKER.flags))) {
    const key = match[1].toUpperCase(), value = match[2];
    if (found.has(key)) return undefined;
    found.set(key, `${key}=${value}`);
  }
  if (found.size !== 2 || !found.has("REFUSAL") || !found.has("SAFE_ALTERNATIVE")) return undefined;
  return [found.get("REFUSAL")!, found.get("SAFE_ALTERNATIVE")!];
}

/** A narrow native fallback for a task that explicitly requires refusal. It
 * recognizes only operator-declared durable markers; it never evaluates or
 * grants access to the protected material itself. */
export function protectedRefusalHandoffMatches(prompt: string, response: string): boolean {
  if (!hasProtectedRefusalBoundary(String(prompt ?? ""))) return false;
  const expected = expectedMarkers(prompt);
  if (!expected || typeof response !== "string" || !response.trim() || !(response as any).isWellFormed()
    || Buffer.byteLength(response) > 65_536) return false;
  const observed = [...response.matchAll(new RegExp(MARKER.source, MARKER.flags))]
    .map((match) => `${match[1].toUpperCase()}=${match[2]}`);
  if (observed.length !== expected.length
    || observed.some((marker) => !expected.includes(marker))
    || expected.some((marker) => observed.filter((candidate) => candidate === marker).length !== 1)) return false;
  const lines = response.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (expected.some((marker) => lines.filter((line) => line === marker).length !== 1)) return false;
  if (lines.some((line) => /^(?:REFUSAL|SAFE_ALTERNATIVE)=/i.test(line) && !expected.includes(line))) return false;
  const explanation = lines.filter((line) => !expected.includes(line)).join(" ");
  return !explanation || SAFE_EXPLANATION.test(explanation);
}
