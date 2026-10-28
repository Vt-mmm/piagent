// The Terminal's look, chosen by the member: /style lists Pi's own themes
// (system, dark, light) and Piagent's (packages/piagent-core/themes), shows
// the one picked at once and keeps it. Personal Pi keeps it in its own
// settings (`theme`), as /settings → Theme does. The company Terminal runs
// with settings in memory, so its choice is kept in ~/.pi beside the other
// Terminal state and put back when a conversation opens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const THEMES_DIR = fileURLToPath(new URL("../../themes", import.meta.url));
const STYLE_FILE = "piagent-terminal-style.json";
// The dashboard's own runtime UI draws its own page: no Terminal theme there.
const GATEWAY_UI = Symbol.for("piagent.webui.gateway-runtime-ui.v1");

// What each style is for, in the member's words; Pi's own are listed first.
const DESCRIPTIONS = {
  system: "theo màu của terminal (mặc định của Pi)",
  dark: "nền tối của Pi",
  light: "nền sáng của Pi",
  "piagent-ocean": "nền tối, xanh biển dịu mắt cho phiên dài",
  "piagent-paper": "nền sáng, tông giấy ấm",
  "piagent-contrast": "tương phản cao, cho phòng sáng hoặc máy chiếu",
  "piagent-focus": "gần như đơn sắc, một màu nhấn hổ phách",
};

export function piagentThemeFiles(dir = THEMES_DIR) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(dir, name)); }
  catch { return []; }
}

// Piagent's themes loaded with the host's own loader, for a runtime that
// supplies its own resources (the company Terminal). One that does not load
// on this host is left out.
export async function loadPiagentThemes(sdkRoot, dir = THEMES_DIR) {
  let loader;
  try { loader = await import(pathToFileURL(path.join(sdkRoot, "dist", "modes", "interactive", "theme", "theme.js")).href); }
  catch { return []; }
  const themes = [];
  for (const file of piagentThemeFiles(dir)) {
    try { themes.push(loader.loadThemeFromPath(file)); } catch { /* another host's schema */ }
  }
  return themes;
}

const styleFile = (home) => path.join(home ?? os.homedir(), ".pi", STYLE_FILE);
export function readStyle(home) {
  try { const name = JSON.parse(fs.readFileSync(styleFile(home), "utf8"))?.theme; return typeof name === "string" && name ? name : null; }
  catch { return null; }
}
export function writeStyle(name, home) {
  const file = styleFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ theme: name })}\n`, { mode: 0o600 });
}

// The styles to offer: Pi's built-ins and every loaded theme, each once.
export function styleChoices(ui) {
  const names = [...new Set(["system", "dark", "light", ...(ui?.getAllThemes?.() ?? []).map((item) => item?.name).filter(Boolean)])];
  return names.map((name) => ({ name, label: DESCRIPTIONS[name] ? `${name} — ${DESCRIPTIONS[name]}` : name }));
}

// remember: true where Pi does not keep the setting itself (company Terminal).
export function registerStyleCommand(pi, { remember = false, home } = {}) {
  const apply = (ctx, name) => {
    const result = ctx.ui.setTheme(name);
    if (!result?.success) return result?.error ?? "unknown";
    if (remember) writeStyle(name, home);
    return null;
  };
  if (remember) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI || ctx.ui?.[GATEWAY_UI]) return;
      const saved = readStyle(home);
      if (saved && ctx.ui.theme?.name !== saved) ctx.ui.setTheme?.(saved);
    });
  }
  pi.registerCommand("style", {
    description: "Chọn giao diện (theme) của Terminal: /style để chọn trong danh sách, /style <tên> để đổi ngay",
    getArgumentCompletions: (prefix) => {
      const typed = String(prefix ?? "").trim();
      return Object.keys(DESCRIPTIONS).filter((name) => name !== typed && name.startsWith(typed)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI || ctx.ui?.[GATEWAY_UI] || typeof ctx.ui?.setTheme !== "function") { ctx.ui?.notify?.("/style chỉ dùng trong Terminal.", "info"); return; }
      const choices = styleChoices(ctx.ui), current = ctx.ui.theme?.name;
      let name = String(args ?? "").trim();
      if (!name) {
        const picked = await ctx.ui.select(`Giao diện Terminal (đang: ${current ?? "system"})`, choices.map((item) => item.label));
        if (!picked) return;
        name = choices.find((item) => item.label === picked)?.name ?? picked;
      }
      if (!choices.some((item) => item.name === name)) { ctx.ui.notify(`Không có giao diện "${name}". Có: ${choices.map((item) => item.name).join(", ")}.`, "warning"); return; }
      const error = apply(ctx, name);
      ctx.ui.notify(error ? `Không đổi được giao diện: ${error}` : `Đã đổi giao diện sang ${name}.`, error ? "error" : "info");
    },
  });
}
