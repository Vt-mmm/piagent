import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export const WORKSPACE_WRITE_ENTRY: "piagent-workspace-write";
export function takeWorkspaceMemberEditNotice(manager: { getBranch(): any[] }): {
  customType: string; display: boolean; content: string; details: { throughEntryId: string };
} | null;
export function registerWorkspaceMemberEdits(pi: ExtensionAPI): void;
