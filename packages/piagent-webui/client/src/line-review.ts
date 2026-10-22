// Line comments on the diff and the review helper's findings, as the Source
// workspace shows them. Comments stay in this tab (sessionStorage) until they
// are sent; they go out as one message with a file:line anchor and the code
// of each line, so the agent can find every place without guessing.
export type LineSide = "new" | "old";
export type LineComment = { path: string; line: number; side: LineSide; code: string; text: string; at: number };
export type ReviewFinding = { severity: "blocking" | "major" | "minor"; file: string; line: number | null; issue: string };

export const LINE_COMMENTS_CHANGED = "piagent-line-comments-changed";
const MAX_COMMENTS = 50, MAX_TEXT = 2000, MAX_CODE = 400;
const storageKey = (sessionRef: string) => `piagent-line-comments:${sessionRef}`;

export const commentKey = (path: string, side: LineSide, line: number) => `${side}:${line}:${path}`;
export const keyOf = (comment: Pick<LineComment, "path" | "side" | "line">) => commentKey(comment.path, comment.side, comment.line);

function valid(value: unknown): value is LineComment {
  const c = value as LineComment;
  return Boolean(c) && typeof c.path === "string" && c.path.length > 0 && Number.isSafeInteger(c.line) && c.line > 0
    && (c.side === "new" || c.side === "old") && typeof c.code === "string" && typeof c.text === "string" && c.text.trim().length > 0;
}

export function readComments(sessionRef: string): LineComment[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(sessionRef)) ?? "[]");
    return Array.isArray(value) ? value.filter(valid).slice(0, MAX_COMMENTS) : [];
  } catch { return []; }
}

export function writeComments(sessionRef: string, comments: LineComment[]): void {
  try {
    if (comments.length) sessionStorage.setItem(storageKey(sessionRef), JSON.stringify(comments.slice(0, MAX_COMMENTS)));
    else sessionStorage.removeItem(storageKey(sessionRef));
  } catch { /* private window: comments last as long as the page */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LINE_COMMENTS_CHANGED, { detail: sessionRef }));
}

// Adds or replaces the comment on one line; an empty text removes it.
export function upsertComment(comments: LineComment[], next: Omit<LineComment, "at">): LineComment[] {
  const rest = comments.filter((c) => keyOf(c) !== keyOf(next));
  const text = next.text.trim().slice(0, MAX_TEXT);
  if (!text) return rest;
  return [...rest, { ...next, text, code: next.code.slice(0, MAX_CODE), at: Date.now() }].slice(-MAX_COMMENTS);
}

const sortComments = (comments: LineComment[]) => [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.side.localeCompare(b.side));

// One message for every comment, grouped by file in line order.
export function reviewMessage(comments: LineComment[], english: boolean): string {
  const sorted = sortComments(comments);
  const head = english
    ? `Review comments on the diff (${sorted.length}). Address each one at its file and line:`
    : `Review comment trên diff (${sorted.length}). Xử lý từng comment đúng file và dòng:`;
  const items = sorted.map((c, index) => {
    const anchor = `${c.path}:${c.line}${c.side === "old" ? (english ? " (removed line)" : " (dòng đã xóa)") : ""}`;
    const fence = c.code.includes("```") ? "````" : "```";
    return `${index + 1}. ${anchor}\n${fence}\n${c.code}\n${fence}\n${c.text}`;
  });
  return [head, ...items].join("\n\n");
}

const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

// A finding names a file as the helper saw it: the path in the diff, or a
// longer or shorter form of it.
export function samePath(finding: string, path: string): boolean {
  const a = normal(finding), b = normal(path);
  return a.length > 0 && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));
}

export function findingsAt(findings: readonly ReviewFinding[] | undefined, path: string, line: number): ReviewFinding[] {
  return (findings ?? []).filter((f) => f.line === line && samePath(f.file, path));
}

// Findings on this file that no shown line carries (no line number, or a
// line outside the diff's hunks).
export function fileFindings(findings: readonly ReviewFinding[] | undefined, path: string, shownLines: ReadonlySet<number>): ReviewFinding[] {
  return (findings ?? []).filter((f) => samePath(f.file, path) && (f.line === null || !shownLines.has(f.line)));
}

// A comment whose line now holds different code (or is gone from the diff)
// was changed after it was written.
export function changedSince(comment: LineComment, lines: ReadonlyMap<string, string> | undefined): boolean {
  if (!lines) return false;
  const now = lines.get(keyOf(comment));
  return now === undefined || now !== comment.code;
}
