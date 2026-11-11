// The Terminal's / commands in a dashboard conversation: typed in the
// composer, run here through the same session commands as the buttons, never
// sent to the model (/undo excepted: the company runtime answers it).
// Plain TypeScript (the root type check has no JSX): the locale helper is repeated here.
import type { UiLocale } from "./locale-preference.ts";
import { acceptAlwaysBypass, alwaysBypassAccepted } from "./view-model.ts";
const localize = (locale: UiLocale, vi: string, en: string) => locale === "vi" ? vi : en;

export type Permission = "read-only" | "workspace-write" | "trusted-full-access" | "bypass" | "always-bypass";
export type CommandNotice = { tone: "success" | "info" | "warning" | "error"; text: string };
export type CommandResult = CommandNotice | { send: true }
  | { confirm: { title: string; description: string; confirmLabel: string; run(): Promise<CommandNotice> } };
export type ConversationCommandContext = {
  locale: UiLocale; company: boolean; running: boolean; pinned: boolean;
  // Company conversations carry fast mode only where the Harness allows it.
  fast: "on" | "off" | null; thinkingLevels: readonly string[];
  /** A company conversation whose Harness allows Bypass. */ bypass?: boolean;
  loadModels(): Promise<Array<{ modelRef: string; label: string }>>;
  actions: { setModel(modelRef: string): Promise<unknown>; setThinking(level: string): Promise<unknown>; setFast(on: boolean): Promise<unknown>;
    setPermission(value: Permission): Promise<unknown>; rename(title: string): Promise<unknown>; fork(): Promise<unknown>; pin(on: boolean): Promise<unknown>;
    archive(): Promise<unknown>; stop(): Promise<unknown>; newChat(): void; openChanges(): void; openSettings(): void };
};
export type ConversationCommand = { name: string; argumentHint: string | null; description: string; run(argument: string): Promise<CommandResult> };

// The keyboard shortcuts /help lists; the palette shows them too.
export const SHORTCUTS = [["⌘K", "Mở bảng lệnh", "Open the command palette"], ["⌘⇧O", "Cuộc trò chuyện mới", "New chat"],
  ["⌘,", "Cài đặt", "Settings"], ["⌘/", "Phím tắt và lệnh /", "Shortcuts and / commands"], ["Esc", "Dừng lượt đang chạy (trong ô nhập)", "Stop the running turn (in the composer)"]] as const;

// `/name` or `/name argument` exactly; anything else is a message.
export function matchConversationCommand(text: string, commands: readonly ConversationCommand[]): { command: ConversationCommand; argument: string } | null {
  const found = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = found ? commands.find((item) => item.name === found[1]) : undefined;
  return command ? { command, argument: (found![2] ?? "").trim() } : null;
}

const failed = (locale: UiLocale, error: unknown, vi: string, en: string): CommandNotice => ({ tone: "error",
  text: error instanceof Error && error.message === "session-runtime-busy" ? localize(locale, `${vi}: lượt này đang chạy, thử lại khi xong.`, `${en}: this turn is running; try again when it ends.`)
    : localize(locale, `${vi}. Thử lại.`, `${en}. Try again.`) });
async function attempt(locale: UiLocale, work: () => Promise<unknown>, done: CommandNotice, vi: string, en: string): Promise<CommandNotice> {
  try { await work(); return done; } catch (error) { return failed(locale, error, vi, en); }
}

export function conversationCommands(context: ConversationCommandContext): ConversationCommand[] {
  const { locale, actions } = context, t = (vi: string, en: string) => localize(locale, vi, en);
  const ok = (vi: string, en: string): CommandNotice => ({ tone: "success", text: t(vi, en) });
  const turnOnAlways = () => { acceptAlwaysBypass(); return attempt(locale, () => actions.setPermission("always-bypass"), ok("Đã bật Always bypass.", "Always bypass is on."), "Chưa đổi được quyền", "Access not changed"); };
  const usage = (vi: string, en: string): CommandNotice => ({ tone: "warning", text: t(vi, en) });
  const commands: ConversationCommand[] = [];
  const add = (name: string, argumentHint: string | null, vi: string, en: string, run: ConversationCommand["run"]) => commands.push({ name, argumentHint, description: t(vi, en), run });

  add("help", null, "Danh sách lệnh / và phím tắt", "The / commands and keyboard shortcuts", async () => ({ tone: "info",
    text: [...commands.map((c) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""} — ${c.description}`),
      ...SHORTCUTS.map(([keys, vi, en]) => `${keys} — ${t(vi, en)}`)].join("\n") }));
  add("new", null, "Cuộc trò chuyện mới", "New chat", async () => { actions.newChat(); return ok("Đã mở cuộc trò chuyện mới.", "Opened a new chat."); });
  add("stop", null, "Dừng lượt đang chạy", "Stop the running turn", async () => !context.running ? { tone: "info", text: t("Không có lượt nào đang chạy.", "No turn is running.") }
    : attempt(locale, actions.stop, ok("Đã dừng lượt đang chạy.", "Stopped the running turn."), "Chưa dừng được", "Could not stop"));
  add("name", "<tên>", "Đổi tên cuộc trò chuyện", "Rename the conversation", async (title) => !title ? usage("Cách dùng: /name <tên mới>", "Usage: /name <new name>")
    : attempt(locale, () => actions.rename(title.slice(0, 200)), ok(`Đã đổi tên thành “${title.slice(0, 200)}”.`, `Renamed to “${title.slice(0, 200)}”.`), "Chưa đổi được tên", "Could not rename"));
  add("fork", null, "Tạo cuộc trò chuyện mới từ cuộc này", "Fork this conversation", async () =>
    attempt(locale, actions.fork, ok("Đã tạo bản sao của cuộc trò chuyện.", "Forked the conversation."), "Chưa tạo được bản sao", "Could not fork"));
  add("pin", null, context.pinned ? "Bỏ ghim cuộc trò chuyện" : "Ghim cuộc trò chuyện", context.pinned ? "Unpin the conversation" : "Pin the conversation", async () =>
    attempt(locale, () => actions.pin(!context.pinned), context.pinned ? ok("Đã bỏ ghim.", "Unpinned.") : ok("Đã ghim.", "Pinned."), "Chưa đổi được ghim", "Could not change the pin"));
  add("archive", null, "Lưu trữ cuộc trò chuyện", "Archive the conversation", async () =>
    attempt(locale, actions.archive, ok("Đã lưu trữ cuộc trò chuyện.", "Archived the conversation."), "Chưa lưu trữ được", "Could not archive"));
  if (context.thinkingLevels.length) add("thinking", `<${context.thinkingLevels.join("|")}>`, "Đổi mức suy luận", "Change the thinking level", async (level) =>
    !context.thinkingLevels.includes(level) ? usage(`Cách dùng: /thinking ${context.thinkingLevels.join("|")}`, `Usage: /thinking ${context.thinkingLevels.join("|")}`)
      : attempt(locale, () => actions.setThinking(level), ok(`Đã đổi thinking sang ${level}.`, `Thinking is now ${level}.`), "Chưa đổi được thinking", "Could not change thinking"));
  if (context.company) {
    add("undo", null, "Hoàn tác file mà lượt trước của agent đã sửa", "Undo the files the agent's last turn changed", async () => ({ send: true }));
    if (context.fast) add("fast", "[on|off]", "Bật/tắt Fast (Harness cho phép)", "Turn Fast on or off (where the Harness allows it)", async (value) => {
      const on = value === "on" ? true : value === "off" ? false : value ? null : context.fast !== "on";
      return on === null ? usage("Cách dùng: /fast on|off", "Usage: /fast on|off")
        : attempt(locale, () => actions.setFast(on), on ? ok("Đã bật Fast.", "Fast is on.") : ok("Đã tắt Fast.", "Fast is off."), "Chưa đổi được Fast", "Could not change Fast");
    });
    add("bypass", "<always|on|full|off>", "Always bypass (không sandbox, chỉ hỏi commit và push), Bypass (chỉ hỏi việc bàn giao), Toàn quyền (hỏi việc bàn giao và việc phá huỷ) hoặc Hỏi trước", "Always bypass (no sandbox, asks only about commit and push), Bypass (asks only about the handoff), Full access (asks about the handoff and destructive steps) or Ask first", async (value) => {
      if (value === "off") return attempt(locale, () => actions.setPermission("workspace-write"), ok("Đã chuyển sang Hỏi trước.", "Switched to Ask first."), "Chưa đổi được quyền", "Access not changed");
      if (value === "always") return alwaysBypassAccepted() ? turnOnAlways() : { confirm: { title: t("Bật Always bypass?", "Turn on Always bypass?"), confirmLabel: t("Bật Always bypass", "Turn on Always bypass"),
        description: t("Cảnh báo, quyền này do bạn quyết định. Không sandbox: mọi lệnh chạy thẳng trên máy, gồm cả internet, MCP, deploy và thông tin đăng nhập; chỉ hỏi khi commit, push code (một lần, ở cuối plan) và xoá đường dẫn quan trọng. Output vẫn che secret, /undo vẫn dùng được.", "Warning: this access is your decision. No sandbox: every command runs directly on this machine, the internet, MCP, deploys and credentials included; only committing and pushing code (once, at the end of the plan) and removing a critical path are asked. Output is still redacted and /undo still works."),
        run: turnOnAlways } };
      if (value === "full") return { confirm: { title: t("Bật Toàn quyền?", "Turn on Full access?"), confirmLabel: t("Bật Toàn quyền", "Turn on Full access"),
        description: t("Lệnh cần internet hoặc Docker chạy không hỏi; push, PR, publish, deploy, migration, xoá không rõ đích và lệnh trên máy vẫn hỏi.", "Commands that need the internet or Docker run without asking; pushes, pull requests, publish, deploys, migrations, unknown-target deletes and commands on this machine still ask."),
        run: () => attempt(locale, () => actions.setPermission("trusted-full-access"), ok("Đã bật Toàn quyền.", "Full access is on."), "Chưa đổi được quyền", "Access not changed") } };
      if (value !== "on") return usage("Cách dùng: /bypass always|on|full|off", "Usage: /bypass always|on|full|off");
      if (!context.bypass) return usage("Harness của team đã tắt Bypass (admin Studio). Dùng /bypass full cho Toàn quyền.", "The team's Harness has Bypass off (Studio administrator). Use /bypass full for Full access.");
      return { confirm: { title: t("Bật Bypass?", "Turn on Bypass?"), confirmLabel: t("Bật Bypass", "Turn on Bypass"),
        description: t("Việc làm chạy luôn (internet, Docker, lệnh trên máy, migration); việc bàn giao vẫn hỏi: push, PR, publish, deploy, upload, MCP ghi ra ngoài. Lệnh thường vẫn trong sandbox; /undo vẫn dùng được.", "The work runs (internet, Docker, commands on this machine, migrations); the handoff is still asked: pushes, pull requests, publish, deploys, uploads, MCP writes. Plain commands stay in the sandbox; /undo still works."),
        run: () => attempt(locale, () => actions.setPermission("bypass"), ok("Đã bật Bypass.", "Bypass is on."), "Chưa đổi được quyền", "Access not changed") } };
    });
  } else {
    add("model", "<tên model>", "Đổi model", "Change the model", async (wanted) => {
      const models = await context.loadModels().catch(() => []), query = wanted.toLowerCase();
      const found = query ? models.filter((m) => m.label.toLowerCase() === query || m.modelRef.toLowerCase() === query) : [];
      const matches = found.length ? found : query ? models.filter((m) => m.label.toLowerCase().includes(query) || m.modelRef.toLowerCase().includes(query)) : [];
      if (matches.length !== 1) return usage(`Cách dùng: /model <tên>. Có: ${models.map((m) => m.label).slice(0, 12).join(", ") || "—"}`, `Usage: /model <name>. Available: ${models.map((m) => m.label).slice(0, 12).join(", ") || "—"}`);
      return attempt(locale, () => actions.setModel(matches[0].modelRef), ok(`Đã đổi model sang ${matches[0].label}.`, `The model is now ${matches[0].label}.`), "Chưa đổi được model", "Could not change the model");
    });
    add("permission", "<read-only|ask|full|bypass|always-bypass>", "Đổi quyền của cuộc trò chuyện", "Change the conversation's access", async (value) => {
      const mode: Permission | null = value === "read-only" ? "read-only" : value === "ask" ? "workspace-write" : value === "full" ? "trusted-full-access" : value === "bypass" ? "bypass" : value === "always-bypass" ? "always-bypass" : null;
      if (!mode) return usage("Cách dùng: /permission read-only|ask|full|bypass|always-bypass", "Usage: /permission read-only|ask|full|bypass|always-bypass");
      const apply = () => attempt(locale, () => actions.setPermission(mode), ok(`Đã đổi quyền sang ${value}.`, `Access is now ${value}.`), "Chưa đổi được quyền", "Access not changed");
      if (mode === "always-bypass") return alwaysBypassAccepted() ? turnOnAlways() : { confirm: { title: t("Bật Always bypass?", "Turn on Always bypass?"), confirmLabel: t("Bật Always bypass", "Turn on Always bypass"),
        description: t("Cảnh báo, quyền này do bạn quyết định. Không sandbox: mọi lệnh chạy thẳng trên máy, gồm cả internet, MCP, deploy và thông tin đăng nhập; chỉ hỏi khi commit, push code (một lần, ở cuối plan) và xoá đường dẫn quan trọng. Output vẫn che secret, /undo vẫn dùng được.", "Warning: this access is your decision. No sandbox: every command runs directly on this machine, the internet, MCP, deploys and credentials included; only committing and pushing code (once, at the end of the plan) and removing a critical path are asked. Output is still redacted and /undo still works."),
        run: turnOnAlways } };
      if (mode === "bypass") return { confirm: { title: t("Bật Bypass?", "Turn on Bypass?"), confirmLabel: t("Bật Bypass", "Turn on Bypass"),
        description: t("Việc làm không bị hỏi hay chặn (xoá, file được bảo vệ đều chạy luôn); việc bàn giao như push, publish, deploy vẫn hỏi. Output vẫn che secret, /undo vẫn hoàn tác được.",
          "The work is not asked about or blocked (deletes and protected files run); the handoff, such as pushes, publish and deploys, is still asked. Output is still redacted and /undo still works."), run: apply } };
      return mode !== "trusted-full-access" ? apply() : { confirm: { title: t("Bật toàn quyền?", "Enable full access?"), confirmLabel: t("Bật toàn quyền", "Enable full access"),
        description: t("Session được đọc, sửa file và chạy command trong phạm vi runtime; xoá hoặc gửi dữ liệu ra ngoài vẫn cần xác nhận riêng.", "The session may read and edit files and run commands within the runtime; destructive actions and external transfers still ask."), run: apply } };
    });
  }
  add("changes", null, "Mở Source Changes", "Open Source Changes", async () => { actions.openChanges(); return ok("Đã mở Source Changes.", "Opened Source Changes."); });
  add("settings", null, "Mở Cài đặt", "Open Settings", async () => { actions.openSettings(); return ok("Đã mở Cài đặt.", "Opened Settings."); });
  return commands;
}
