// Where a file named in an answer or a mention is, in the project.
export type WorkspaceTarget = { path: string; line: number };
export function workspaceTarget(value: string, line = 1): WorkspaceTarget | null {
  const match = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(value.replace(/^@/, ""));
  const file = match?.[1];
  if (!file || file.length > 4096 || /^[~/]/.test(file) || /[\\\x00-\x1f\x7f:]/.test(file)
    || file.split("/").some(part => !part || part === "." || part === "..")) return null;
  return { path: file, line: Math.max(1, Math.min(1_000_000, Number(match?.[2]) || line || 1)) };
}
// A file the agent hands back in its answer, as a Markdown link or `code`:
// a project path (src/app.ts, ./src/app.ts:42, src/app.ts#L42), or an
// absolute one / file:// URL inside the project, resolved when it is opened.
export type FileLink = { path: string; line: number; absolute: boolean };
export function fileLink(href: string): FileLink | null {
  let value = href.trim();
  if (!value || value.length > 4096 || /^(?:https?|mailto|data|javascript):/i.test(value) || value.startsWith("#")) return null;
  if (/^file:/i.test(value)) { try { value = new URL(value).pathname; } catch { return null; } }
  try { value = decodeURIComponent(value); } catch { /* keep as written */ }
  const anchor = /#L(\d+)(?:-L?\d+)?$/.exec(value), line = anchor ? Number(anchor[1]) : undefined;
  if (anchor) value = value.slice(0, anchor.index);
  value = value.replace(/^\.\//, "");
  if (value.startsWith("/")) {
    const match = /^(\/.+?)(?::(\d+)(?::\d+)?)?$/.exec(value), file = match?.[1] ?? "";
    if (!file || /[\x00-\x1f\x7f]/.test(file) || file.split("/").slice(1).some(part => !part || part === "." || part === "..")) return null;
    return { path: file, line: Math.max(1, Math.min(1_000_000, line ?? (Number(match?.[2]) || 1))), absolute: true };
  }
  const target = workspaceTarget(value, line);
  return target ? { ...target, absolute: false } : null;
}
