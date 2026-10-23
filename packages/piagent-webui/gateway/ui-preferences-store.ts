import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// The dashboard's language and colour theme, kept by the Gateway so they
// survive a restart: the browser's own storage belongs to one origin, and the
// dashboard's port changes each time it starts.
export type UiPreferences = { locale?: "vi" | "en"; themeId?: string };
const MAX_BYTES = 4096, THEME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function valid(value: unknown): UiPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { locale, themeId, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (locale !== undefined && locale !== "vi" && locale !== "en") return null;
  if (themeId !== undefined && (typeof themeId !== "string" || !THEME.test(themeId))) return null;
  return { ...(locale ? { locale: locale as "vi" | "en" } : {}), ...(themeId ? { themeId: themeId as string } : {}) };
}

export class UiPreferencesStore {
  readonly file: string;
  #root: string;
  constructor(root: string) { this.#root = root; this.file = path.join(root, "ui-preferences.json"); }

  read(): UiPreferences {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return {};
      return valid(JSON.parse(fs.readFileSync(this.file, "utf8"))) ?? {};
    } catch { return {}; }
  }

  // Merges what the browser sent; anything else is refused unchanged.
  write(value: unknown): UiPreferences {
    const change = valid(value);
    if (!change) throw new Error("preferences-invalid");
    const next = { ...this.read(), ...change };
    const temporary = path.join(this.#root, `.ui-preferences-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(descriptor, `${JSON.stringify(next)}\n`); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, this.file);
    return next;
  }
}
