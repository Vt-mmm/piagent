// A company conversation (Agent Watch's ManagedSessions store, or one that
// carries its run entries) belongs to `piagent studio`. Opened in personal Pi,
// for example through Pi's "To resume this session: pi --session-dir …", it
// would go on with the member's personal models, keys, extensions and
// settings, outside the team's Harness; personal Pi refuses it instead.
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPANY_PROVIDER = "agent_watch_managed";
const STORE = "/AgentWatch/ManagedSessions/";

export function isCompanySession(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  const file = String(ctx.sessionManager?.getSessionFile?.() ?? "").split(path.sep).join("/");
  if (file.includes(STORE)) return true;
  try {
    return ctx.sessionManager.getEntries().some((entry: any) => typeof entry?.customType === "string" && entry.customType.startsWith("agent-watch-run"));
  } catch {
    return false;
  }
}

const quoted = (value: string) => /^[\w./~:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export function companySessionNotice(cwd: string): string {
  return `Đây là cuộc trò chuyện công ty: mở bằng \`piagent studio --project ${quoted(cwd)}\` rồi gõ /resume. `
    + "Pi cá nhân không tiếp tục nó, vì sẽ chạy bằng model, key và cấu hình cá nhân thay vì Harness của team.";
}

export function registerCompanySessionGuard(pi: ExtensionAPI) {
  pi.on("input", (_event, ctx) => {
    if (ctx.model?.provider === COMPANY_PROVIDER || !isCompanySession(ctx)) return { action: "continue" };
    const notice = companySessionNotice(ctx.cwd);
    if (ctx.hasUI) ctx.ui.notify(notice, "error");
    else { process.stderr.write(`${notice}\n`); process.exitCode = 1; }
    return { action: "handled" };
  });
}
