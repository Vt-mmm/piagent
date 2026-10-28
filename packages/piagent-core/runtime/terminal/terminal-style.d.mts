export const THEMES_DIR: string;
export function piagentThemeFiles(dir?: string): string[];
export function loadPiagentThemes(sdkRoot: string, dir?: string): Promise<unknown[]>;
export function readStyle(home?: string): string | null;
export function writeStyle(name: string, home?: string): void;
export function styleChoices(ui: unknown): { name: string; label: string }[];
export function registerStyleCommand(pi: unknown, options?: { remember?: boolean; home?: string }): void;
