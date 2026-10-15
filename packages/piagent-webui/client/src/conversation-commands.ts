// The Terminal's / commands in a dashboard conversation: typed in the
// composer, run here through the same session commands as the buttons, never
// sent to the model (/undo excepted: the company runtime answers it).
// Plain TypeScript (the root type check has no JSX): the locale helper is repeated here.
import type { UiLocale } from "./locale-preference.ts";
const localize = (locale: UiLocale, vi: string, en: string) => locale === "vi" ? vi : en;

export type Permission = "read-only" | "workspace-write" | "trusted-full-access";
export type CommandNotice = { tone: "success" | "info" | "warning" | "error"; text: string };
export type CommandResult = CommandNotice | { send: true }
  | { confirm: { title: string; description: string; confirmLabel: string; run(): Promise<CommandNotice> } };
export type ConversationCommandContext = {
  locale: UiLocale; company: boolean; running: boolean; pinned: boolean;
  // Company conversations carry fast mode only where the Harness allows it.
  fast: "on" | "off" | null; thinkingLevels: readonly string[];
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
    add("bypass", "<on|off>", "Bypass: chỉ hỏi việc bắt buộc, hoặc hỏi trước", "Bypass: ask only what must be asked, or ask first", async (value) => {
      if (value === "off") return attempt(locale, () => actions.setPermission("workspace-write"), ok("Đã chuyển sang Hỏi trước.", "Switched to Ask first."), "Chưa đổi được quyền", "Access not changed");
      if (value !== "on") return usage("Cách dùng: /bypass on|off", "Usage: /bypass on|off");
      return { confirm: { title: t("Bật Bypass?", "Turn on Bypass?"), confirmLabel: t("Bật Bypass", "Turn on Bypass"),
        description: t("Lệnh cần internet hoặc Docker chạy không hỏi; push, deploy và lệnh trên máy vẫn hỏi.", "Commands that need the internet or Docker run without asking; pushes, deploys and commands on this machine still ask."),
        run: () => attempt(locale, () => actions.setPermission("trusted-full-access"), ok("Đã bật Bypass.", "Bypass is on."), "Chưa đổi được quyền", "Access not changed") } };
    });
  } else {
    add("model", "<tên model>", "Đổi model", "Change the model", async (wanted) => {
      const models = await context.loadModels().catch(() => []), query = wanted.toLowerCase();
      const found = query ? models.filter((m) => m.label.toLowerCase() === query || m.modelRef.toLowerCase() === query) : [];
      const matches = found.length ? found : query ? models.filter((m) => m.label.toLowerCase().includes(query) || m.modelRef.toLowerCase().includes(query)) : [];
      if (matches.length !== 1) return usage(`Cách dùng: /model <tên>. Có: ${models.map((m) => m.label).slice(0, 12).join(", ") || "—"}`, `Usage: /model <name>. Available: ${models.map((m) => m.label).slice(0, 12).join(", ") || "—"}`);
      return attempt(locale, () => actions.setModel(matches[0].modelRef), ok(`Đã đổi model sang ${matches[0].label}.`, `The model is now ${matches[0].label}.`), "Chưa đổi được model", "Could not change the model");
    });
    add("permission", "<read-only|ask|full>", "Đổi quyền của cuộc trò chuyện", "Change the conversation's access", async (value) => {
      const mode: Permission | null = value === "read-only" ? "read-only" : value === "ask" ? "workspace-write" : value === "full" ? "trusted-full-access" : null;
      if (!mode) return usage("Cách dùng: /permission read-only|ask|full", "Usage: /permission read-only|ask|full");
      const apply = () => attempt(locale, () => actions.setPermission(mode), ok(`Đã đổi quyền sang ${value}.`, `Access is now ${value}.`), "Chưa đổi được quyền", "Access not changed");
      return mode !== "trusted-full-access" ? apply() : { confirm: { title: t("Bật toàn quyền?", "Enable full access?"), confirmLabel: t("Bật toàn quyền", "Enable full access"),
        description: t("Session được đọc, sửa file và chạy command trong phạm vi runtime; xoá hoặc gửi dữ liệu ra ngoài vẫn cần xác nhận riêng.", "The session may read and edit files and run commands within the runtime; destructive actions and external transfers still ask."), run: apply } };
    });
  }
  add("changes", null, "Mở Source Changes", "Open Source Changes", async () => { actions.openChanges(); return ok("Đã mở Source Changes.", "Opened Source Changes."); });
  add("settings", null, "Mở Cài đặt", "Open Settings", async () => { actions.openSettings(); return ok("Đã mở Cài đặt.", "Opened Settings."); });
  return commands;
}
