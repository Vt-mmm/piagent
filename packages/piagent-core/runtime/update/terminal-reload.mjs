// Every open Terminal moves to a new Piagent release without being closed.
//
// `piagent reload` (and `piagent-update` once it installed a release) writes
// one request file. Each Terminal started before that request takes it when it
// is idle: no run going, nothing queued, nothing typed in the editor. A run in
// progress is never cut: the footer says the reload waits, and it happens when
// the run settles. How a Terminal reloads is its own: the personal Terminal
// runs Pi's /reload (Piagent's extensions are read again from disk), the
// company Terminal starts again in place on the same conversation, since its
// company code is loaded once per process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUEST_FILE = "piagent-reload.json";
const POLL_MS = 2_000;
const STATUS_KEY = "piagent-reload";

const requestPath = (home) => path.join(home ?? os.homedir(), ".pi", REQUEST_FILE);

export function requestTerminalReload({ home, version = null, piHost = null, now = Date.now() } = {}) {
  const file = requestPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version, piHost, at: now })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { version, piHost, at: now };
}

export function readReloadRequest(home) {
  try {
    const value = JSON.parse(fs.readFileSync(requestPath(home), "utf8"));
    if (!Number.isFinite(value?.at)) return null;
    return { at: value.at, version: typeof value.version === "string" ? value.version : null, piHost: typeof value.piHost === "string" ? value.piHost : null };
  } catch { return null; }
}

// Whether this Terminal may reload now without losing anything the member did.
function idle(ctx) {
  try {
    if (typeof ctx?.isIdle === "function" && !ctx.isIdle()) return false;
    if (typeof ctx?.hasPendingMessages === "function" && ctx.hasPendingMessages()) return false;
    const typed = typeof ctx?.ui?.getEditorText === "function" ? ctx.ui.getEditorText() : "";
    return !String(typed ?? "").trim();
  } catch { return false; }
}

// `apply(ctx, request)` reloads this Terminal; it runs at most once per
// process. Only Terminals with a UI take requests: scripted runs keep theirs.
export function watchTerminalReload(pi, { apply, home, startedAt = Date.now(), pollMs = POLL_MS }) {
  let ctx = null, applied = false, waiting = false, timer = null;
  // A ctx kept from an earlier session (replaced, reloaded) throws on any use:
  // a check that meets one does nothing, and the next session_start brings a new one.
  const check = async () => {
    let request;
    try {
      if (applied || !ctx?.hasUI) return;
      request = readReloadRequest(home);
      if (!request || request.at <= startedAt) return;
      if (!idle(ctx)) {
        if (!waiting) { waiting = true; ctx.ui?.setStatus?.(STATUS_KEY, `⟳ Nạp Piagent${request.version ? ` ${request.version}` : " mới"} khi xong lượt này`); }
        return;
      }
      applied = true;
      ctx.ui?.setStatus?.(STATUS_KEY, undefined);
    } catch { return; }
    try { await apply(ctx, request); }
    catch (error) {
      applied = false;
      try { ctx.ui?.notify?.(`Chưa nạp được Piagent mới: ${error instanceof Error ? error.message : String(error)}`, "warning"); } catch { /* the session is gone */ }
    }
  };
  const keep = (_event, next) => { ctx = next; };
  pi.on("session_start", (event, next) => {
    keep(event, next);
    if (!timer) { timer = setInterval(() => { void check(); }, pollMs); timer.unref?.(); }
  });
  pi.on("agent_start", keep);
  // The moment a run settles is the moment a waiting reload can happen.
  pi.on("agent_settled", (event, next) => { keep(event, next); setTimeout(() => { void check(); }, 300).unref?.(); });
  pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = null; ctx = null; });
  return { check };
}

// The personal Terminal: Pi's /reload reads Piagent's extensions again from
// disk and keeps the conversation. A request naming another Pi host than the
// one running cannot be met that way: the member is told to open it again.
const RELOADED_FROM = "PIAGENT_RELOADED_FROM";
// The Pi this process runs: the package of the CLI that started it.
function runningPiVersion() {
  try {
    for (let dir = path.dirname(fs.realpathSync(process.argv[1])), depth = 0; depth < 6; depth += 1, dir = path.dirname(dir)) {
      try { const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); if (manifest.name === "@earendil-works/pi-coding-agent") return manifest.version; } catch { /* keep walking up */ }
    }
  } catch { /* unknown */ }
  return null;
}
export function registerPersonalTerminalReload(pi, { installed, home = undefined }) {
  pi.registerCommand("piagent-reload", { description: "Nạp lại Piagent (bản vừa cập nhật) mà không đóng Terminal",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      process.env[RELOADED_FROM] = installed ?? "?";
      await ctx.reload();
    } });
  pi.on("session_start", (_event, ctx) => {
    const from = process.env[RELOADED_FROM];
    if (from === undefined) return;
    delete process.env[RELOADED_FROM];
    // Said once the reloaded Terminal has drawn itself: a notice during the reload is lost.
    const text = from === installed ? `Đã nạp lại Piagent ${installed}.` : `Đã nạp Piagent ${installed} (trước đó ${from}).`;
    setTimeout(() => { try { ctx.ui?.notify?.(text, "info"); } catch { /* the Terminal closed meanwhile */ } }, 300).unref?.();
  });
  watchTerminalReload(pi, { home, apply: async (ctx, request) => {
    if (ctx.mode !== "tui") return;
    const VERSION = runningPiVersion();
    if (request.piHost && VERSION && request.piHost !== VERSION) {
      ctx.ui.notify(`Piagent ${request.version ?? "mới"} chạy trên Pi ${request.piHost}, Terminal này đang dùng Pi ${VERSION}: thoát rồi mở lại \`piagent\` để dùng bản mới.`, "warning");
      return;
    }
    await pi.sendUserMessage("/piagent-reload", { expandPromptTemplates: true });
  } });
}
