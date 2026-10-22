import type { CheckpointReceipt } from '../contracts/generated/checkpoint-v1.ts';
import { SignedSessionJournal } from './signed-session-journal.ts';

export class CheckpointReceiptStore extends SignedSessionJournal<CheckpointReceipt> {
  constructor(root: string, key: Buffer) { super(root, key, 'checkpoint-receipts'); }
}
