export function memberId(origin: unknown, userId: unknown): string | null;
export function storedSlot(root: string, slot: string): string | null;
export function resolveStore(root: string, slot: string, identity: { origin: unknown; userId: unknown }): string;
