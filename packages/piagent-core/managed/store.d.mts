export function memberId(origin: unknown, userId: unknown): string | null;
export function storedSlot(root: string, slot: string): string | null;
export function resolveStore(root: string, slot: string, identity: { origin: unknown; userId: unknown }): string;
export function agentWatchDataDirectory(home: string, environment?: Readonly<Record<string, string | undefined>>): string;
export function interopEnvironment(environment?: Readonly<Record<string, string | undefined>>): Record<string, string>;
