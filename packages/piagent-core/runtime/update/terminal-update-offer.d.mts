export const SNOOZE_MS: number;
export function readSnooze(home?: string): { version: string | undefined; until: number };
export function snoozeUpdate(version: string, options?: { home?: string; now?: number }): void;
export function pendingUpdate(options: { installed: string | undefined; home?: string; now?: number }): string | null;
export function probeRegistry(options?: { wait?: boolean; spawnImpl?: unknown }): Promise<boolean>;
export function runPiagentUpdate(options: { packageRoot: string; version: string; home?: string; spawnImpl?: unknown }): Promise<{ ok: boolean; log: string }>;
export function registerTerminalUpdateOffer(pi: unknown, options: { installed: string | undefined; packageRoot: string; restart: string; home?: string; afterUpdate?: () => string | null; runUpdate?: (options: { packageRoot: string; version: string; home?: string }) => Promise<{ ok: boolean; log: string }>; probe?: (options?: { wait?: boolean }) => Promise<boolean> }): void;
