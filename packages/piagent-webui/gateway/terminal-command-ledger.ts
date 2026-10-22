import type { TerminalCommand, TerminalReceipt } from "../contracts/generated/terminal-v1.ts";
import { parseTerminalCommand } from "../server/terminal-command.ts";
import { reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
type Entry = { fingerprint: string; expiresAt: number; result: Promise<TerminalReceipt> };
// PTYs belong to one Gateway runtime. Its identity must be checked by the
// session controller; a restarted Gateway cannot replay into a replacement PTY.
export class TerminalCommandLedger {
  readonly #entries = new Map<string, Entry>();
  readonly #limit: number;
  readonly #now: () => number;
  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.#limit = options.limit ?? 32768; this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#limit) || this.#limit < 1 || this.#limit > 32768) throw new Error("terminal-ledger-invalid-limit");
  }
  async execute(value: unknown, effect: (command: TerminalCommand) => Promise<TerminalReceipt>,
    uncertain: (command: TerminalCommand) => TerminalReceipt): Promise<TerminalReceipt> {
    const command = parseTerminalCommand(value), now = this.#now(), expiresAt = Date.parse(command.expiresAt);
    for (const [key, entry] of this.#entries) if (entry.expiresAt < now) this.#entries.delete(key);
    if (expiresAt < now || Date.parse(command.requestedAt) > now + 5000) throw new Error("terminal-command-expired");
    const key = `${command.identity.sessionRef}\0${command.idempotencyKey}`, fingerprint = reviewDigest(command);
    const previous = this.#entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("terminal-idempotency-conflict");
      return { ...await previous.result, deduplicated: true };
    }
    if (this.#entries.size >= this.#limit) throw new Error("terminal-command-capacity");
    // Publish the pending result before invoking native code. A concurrent
    // retry waits for it; an ambiguous native error is never dispatched again.
    const result = Promise.resolve().then(() => effect(command)).catch(() => uncertain(command));
    this.#entries.set(key, { fingerprint, expiresAt, result });
    return { ...await result, deduplicated: false };
  }
}
