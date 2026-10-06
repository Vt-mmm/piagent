// What a member typed and has not sent yet, for each conversation and for the
// new chat page: kept when they open another conversation and come back, and
// in this browser across a reload. Staged files and a send still being
// confirmed are kept for the open page only (they belong to the running
// Gateway). A draft is dropped once its message is sent.
export const NEW_CHAT_DRAFT = "new-chat";

const STORAGE_KEY = "piagent.composer-drafts.v1";
const MAX_DRAFTS = 50;
const MAX_CHARS = 32_768;
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

type Saved = { text: string; savedAt: number };
let texts: Map<string, Saved> | null = null;
let pending: number | undefined;
const memory = new Map<string, unknown>();

function load(): Map<string, Saved> {
  if (texts) return texts;
  texts = new Map();
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, Partial<Saved>>;
    const now = Date.now();
    for (const [key, value] of Object.entries(stored ?? {})) {
      if (typeof value?.text === "string" && typeof value.savedAt === "number" && now - value.savedAt < KEEP_MS)
        texts.set(key, { text: value.text.slice(0, MAX_CHARS), savedAt: value.savedAt });
    }
  } catch { /* a private window or blocked storage: drafts live for this page only */ }
  return texts;
}

function flush(): void {
  if (pending !== undefined) { window.clearTimeout(pending); pending = undefined; }
  try {
    const newest = [...load()].sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_DRAFTS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch { /* storage full or blocked */ }
}

let listening = false;
function persistSoon(): void {
  // A tab closed right after typing still keeps the last keystrokes.
  if (!listening) { listening = true; window.addEventListener("pagehide", flush); }
  if (pending === undefined) pending = window.setTimeout(flush, 300);
}

export function readDraft(key: string): string {
  return load().get(key)?.text ?? "";
}

export function writeDraft(key: string, text: string): void {
  const drafts = load();
  if (text.trim()) drafts.set(key, { text: text.slice(0, MAX_CHARS), savedAt: Date.now() });
  else if (!drafts.delete(key)) return;
  persistSoon();
}

// Composer state that cannot leave the page: staged files, the request id
// they were staged under, a send not yet confirmed.
export function readComposerMemory<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined;
}

export function writeComposerMemory<T>(key: string, value: T | null): void {
  if (value === null) memory.delete(key); else memory.set(key, value);
}
