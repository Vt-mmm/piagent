import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import {
  DOCUMENT_EXTENSIONS,
  extractDocument,
  resolveDocumentPath,
  resolveDocumentRoots,
  type DocumentRoot
} from "../../extensions/document-intake.ts";

// Opening documents in the browser.
//
// The tool `piagent_document_read` already answers "read this path" for the
// model. This answers "what is there to read, and show me one" for the operator,
// and it is deliberately built on the same three functions: the roots come from
// `resolveDocumentRoots`, every path is decided by `resolveDocumentPath`, and the
// bytes are turned into text by `extractDocument`. A second implementation of
// containment or of the extension gate would be a second thing to keep correct,
// and the one that drifted would be this one, because it is the one nobody runs
// from a terminal.
//
// Two rules the listing adds on top:
//
// A name is not an authority. The browser never sends a path — it sends an
// opaque ref, and the ref is resolved by re-listing and matching. A path that
// stopped being listable between the listing and the read is simply not found,
// which is the same answer as a path that was never listed.
//
// The walk does not follow links. Containment is decided on the canonical path
// at read time, so a link out of a root could never be *read*, but following one
// during the walk would still put its target's name in front of the operator.

export const DOCUMENT_WORKSPACE_LIMITS = Object.freeze({
  documents: 2000,
  // A shared budget spent in root order lets a large project consume all of it
  // and leave a granted directory — the one the operator added on purpose —
  // showing nothing at all. Each root gets its own slice instead, with a floor
  // so a small grant is never squeezed to nothing by a big one.
  documentsPerRootFloor: 250,
  depth: 8,
  entriesPerDirectory: 4096,
  text: 400_000
});

// Directories that are large, uninteresting, and present in almost every
// project. Walking them costs seconds and returns vendored copies of documents
// the operator did not write.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__",
  "target", "vendor", ".gradle", ".idea", ".tmp", ".playwright"
]);

const EXTENSIONS = new Set(DOCUMENT_EXTENSIONS);

export type DocumentWorkspaceEntry = {
  documentRef: string;
  rootRef: string;
  name: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
};
export type DocumentWorkspaceRoot = { rootRef: string; path: string; source: DocumentRoot["source"]; documentCount: number };
export type DocumentWorkspaceListing = {
  schemaVersion: 1;
  version: "piagent-webui-document-workspace-v1";
  messageType: "listing";
  generatedAt: string;
  state: "ready" | "unavailable";
  roots: DocumentWorkspaceRoot[];
  documents: DocumentWorkspaceEntry[];
  truncated: boolean;
  reasonCode: string | null;
};
export type DocumentWorkspaceDocument = {
  schemaVersion: 1;
  version: "piagent-webui-document-workspace-v1";
  messageType: "document";
  generatedAt: string;
  documentRef: string;
  state: "ready" | "unavailable";
  // Null wherever the document could not be identified at all. A document that
  // was found but could not be read still names itself, so the operator sees
  // which file the refusal is about.
  name: string | null;
  relativePath: string | null;
  rootRef: string | null;
  format: "text" | "docx" | "pdf" | null;
  text: string | null;
  sizeBytes: number | null;
  truncated: boolean;
  redacted: boolean;
  reasonCode: string | null;
};

export type DocumentWorkspaceInput = {
  cwd: string;
  profileRoots?: unknown;
  environmentRoots?: string | undefined;
  home?: string | undefined;
  isProtectedPath?: (candidate: string) => boolean;
  now?: () => Date;
};

function ref(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(value).digest("hex")}`;
}

// A control character in a name would sit inside a JSON string safely enough,
// but this text is also rendered, copied and logged. Stripping is cheaper than
// auditing every place it lands.
function displayName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
}

function timestamp(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1000) * 1000).toISOString();
}

function extensionOf(name: string): string | undefined {
  const extension = path.extname(name).toLowerCase().replace(/^\./, "");
  return EXTENSIONS.has(extension) ? extension : undefined;
}

// Only regular files and real directories are considered, and both are judged by
// lstat so a link is seen as a link rather than as whatever it points at.
function walkRoot(root: DocumentRoot, budget: { remaining: number }, isProtected: (relative: string, absolute: string) => boolean,
  paths: Map<string, string>): DocumentWorkspaceEntry[] {
  const rootRef = ref("document-root", root.path), found: DocumentWorkspaceEntry[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root.path, depth: 0 }];
  while (queue.length > 0 && budget.remaining > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
    catch { continue; }
    // A directory with more entries than this is a data directory, not a place
    // an operator keeps documents, and reading all of it is what makes a listing
    // take seconds.
    if (entries.length > DOCUMENT_WORKSPACE_LIMITS.entriesPerDirectory) continue;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (budget.remaining <= 0) break;
      // A Dirent already reports a link as a link, so the isFile and isDirectory
      // tests below reject one on their own. This says so out loud, because a
      // later refactor to stat-based checks would silently start following them.
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, entry.name);
      const relative = path.relative(root.path, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (current.depth + 1 > DOCUMENT_WORKSPACE_LIMITS.depth) continue;
        if (isProtected(relative, absolute)) continue;
        queue.push({ directory: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extensionOf(entry.name);
      if (!extension || isProtected(relative, absolute)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(absolute); }
      catch { continue; }
      if (!stat.isFile() || stat.size <= 0) continue;
      budget.remaining -= 1;
      const documentRef = ref("document", absolute);
      // The projected name is stripped for display. Resolution must run on the
      // path as it exists on disk, so the exact bytes are kept beside the ref
      // and never rebuilt from what the browser was shown.
      paths.set(documentRef, absolute);
      found.push({ documentRef, rootRef, name: displayName(entry.name),
        relativePath: displayName(relative), extension, sizeBytes: stat.size, modifiedAt: timestamp(stat.mtime) });
    }
  }
  return found;
}

function protectedPredicate(input: DocumentWorkspaceInput): (relative: string, absolute: string) => boolean {
  const custom = input.isProtectedPath;
  if (!custom) return () => false;
  // Protected patterns are project-relative and anchored at the first segment, so
  // an absolute candidate only ever matches a `**/`-prefixed one. Checking a
  // single form would let every anchored entry through, the same way the document
  // tool checks both.
  return (relative, absolute) => custom(absolute) || custom(relative);
}

// The listing and the raw paths behind it, produced together. Only the listing
// crosses to the browser; the paths stay here so a read never has to rebuild one
// from projected text.
function collectDocuments(input: DocumentWorkspaceInput): { listing: DocumentWorkspaceListing; roots: DocumentRoot[]; paths: Map<string, string> } {
  const now = (input.now ?? (() => new Date()))();
  const base = { schemaVersion: 1 as const, version: "piagent-webui-document-workspace-v1" as const,
    messageType: "listing" as const, generatedAt: timestamp(now) };
  const empty = (reasonCode: string) => ({ listing: { ...base, state: "unavailable" as const, roots: [], documents: [],
    truncated: false, reasonCode }, roots: [] as DocumentRoot[], paths: new Map<string, string>() });
  let roots: DocumentRoot[];
  try {
    roots = resolveDocumentRoots({ cwd: input.cwd, profileRoots: input.profileRoots,
      environmentRoots: input.environmentRoots, home: input.home });
  } catch { return empty("document-roots-unavailable"); }
  if (roots.length === 0) return empty("no-readable-root");

  const isProtected = protectedPredicate(input);
  const perRoot = Math.max(DOCUMENT_WORKSPACE_LIMITS.documentsPerRootFloor,
    Math.floor(DOCUMENT_WORKSPACE_LIMITS.documents / roots.length));
  const paths = new Map<string, string>();
  const documents: DocumentWorkspaceEntry[] = [], projected: DocumentWorkspaceRoot[] = [];
  let truncated = false;
  for (const root of roots) {
    const budget = { remaining: Math.min(perRoot, Math.max(0, DOCUMENT_WORKSPACE_LIMITS.documents - documents.length)) };
    const found = walkRoot(root, budget, isProtected, paths);
    truncated ||= budget.remaining <= 0;
    projected.push({ rootRef: ref("document-root", root.path), path: displayName(root.path), source: root.source, documentCount: found.length });
    documents.push(...found);
  }
  return { listing: { ...base, state: "ready", roots: projected, documents, truncated, reasonCode: null }, roots, paths };
}

export function projectDocumentWorkspaceListing(input: DocumentWorkspaceInput): DocumentWorkspaceListing {
  return collectDocuments(input).listing;
}

export function projectDocumentWorkspaceDocument(input: DocumentWorkspaceInput & { documentRef: string }): DocumentWorkspaceDocument {
  const now = (input.now ?? (() => new Date()))();
  const base = { schemaVersion: 1 as const, version: "piagent-webui-document-workspace-v1" as const,
    messageType: "document" as const, generatedAt: timestamp(now), documentRef: input.documentRef };
  const unavailable = (reasonCode: string): DocumentWorkspaceDocument => ({ ...base, state: "unavailable", name: null, relativePath: null,
    rootRef: null, format: null, text: null, sizeBytes: null, truncated: false, redacted: false, reasonCode });

  // The ref is matched against a listing taken now, so opening a document proves
  // it is still listable rather than trusting a ref the browser has been holding.
  const { listing, roots, paths } = collectDocuments(input);
  if (listing.state !== "ready") return unavailable(listing.reasonCode ?? "document-roots-unavailable");
  const entry = listing.documents.find((candidate) => candidate.documentRef === input.documentRef);
  const absolute = paths.get(input.documentRef);
  if (!entry || !absolute) return unavailable("document-not-listed");

  // Resolution runs against the same roots the walk used, so the extension gate,
  // the size cap, the symlink canonicalisation and the containment check are the
  // ones the document tool applies — including the identity that extractDocument
  // re-proves when it opens the file.
  const resolved = resolveDocumentPath(absolute, roots, { cwd: input.cwd, home: input.home });
  if (resolved.status === "error") return unavailable("document-unavailable");
  // The walk above already dropped protected documents, so a protected ref fails
  // to match a listing entry before it reaches here. Both of the next two checks
  // are the invariant stated rather than assumed: they hold the guarantee in
  // place if the listing filter is ever loosened or the ref scheme changes.
  const isProtected = protectedPredicate(input);
  const relative = path.relative(resolved.root.path, resolved.absolutePath).split(path.sep).join("/");
  if (isProtected(relative, resolved.absolutePath)) return unavailable("document-protected");
  // Roots are canonical and the walk never traverses a link, so the listed path
  // is already the canonical one and this equality holds by construction. It is
  // re-derived anyway: the cost is a hash, and what it protects is the rule that
  // the browser can only ever name a document the listing chose to expose.
  if (ref("document", resolved.absolutePath) !== input.documentRef) return unavailable("document-changed");

  const extracted = extractDocument(resolved);
  if (extracted.status === "error") {
    return { ...unavailable(extracted.reason.includes("needs OCR") ? "document-needs-ocr"
      : extracted.reason.includes("pdftotext") ? "document-converter-unavailable" : "document-unreadable"),
    name: entry.name, relativePath: entry.relativePath, rootRef: entry.rootRef };
  }
  // The same redaction the document tool applies before the model sees a file.
  // The operator can open the original in an editor; what crosses this boundary
  // is a projection, and projections in this read model do not carry secrets.
  const safe = redactSensitiveText(extracted.text);
  const capped = safe.text.length > DOCUMENT_WORKSPACE_LIMITS.text
    ? { text: safe.text.slice(0, DOCUMENT_WORKSPACE_LIMITS.text), truncated: true }
    : { text: safe.text, truncated: false };
  return { ...base, state: "ready", name: entry.name, relativePath: entry.relativePath, rootRef: entry.rootRef,
    format: extracted.kind, text: capped.text, sizeBytes: entry.sizeBytes,
    truncated: extracted.truncated || capped.truncated, redacted: safe.redacted, reasonCode: null };
}
