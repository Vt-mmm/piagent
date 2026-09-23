type BranchEntry = { id: string; parentId: string | null; type: string; message?: { role: string } };

// Pi may persist system prompt updates before the user message in the same dispatch.
// Do not cross any other entry kind or another user's/assistant's message.
export function firstUserEntryAfter<T extends BranchEntry>(branch: readonly T[], parentId: string | null): T | null {
  for (const entry of branch) {
    if (entry.parentId !== parentId) continue;
    if (entry.type !== "message") return null;
    if (entry.message?.role === "system") { parentId = entry.id; continue; }
    return entry.message?.role === "user" ? entry : null;
  }
  return null;
}
