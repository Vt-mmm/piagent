import type { WorkspaceWriteReceipt } from "../contracts/generated/workspace-write-v1.ts";
import { SignedSessionJournal } from "./signed-session-journal.ts";

export class WorkspaceWriteStore extends SignedSessionJournal<WorkspaceWriteReceipt> {
  constructor(root: string, key: Buffer) { super(root, key, "workspace-writes"); }
}
