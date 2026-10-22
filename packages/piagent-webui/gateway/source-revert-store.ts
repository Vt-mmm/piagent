import path from "node:path";
import { reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import type { SourceRevertEvidenceAppend, SourceRevertEvidenceRecord, SourceRevertEvidenceStore } from "../server/source-revert-controller.ts";
import { SignedSessionJournal } from "./signed-session-journal.ts";

type Envelope = { identity: { sessionRef: string }; idempotencyKeyDigest: string; record: SourceRevertEvidenceRecord };

// Gateway state, outside the project and company worker. The signed journal
// keeps only evidence metadata; pending records survive an interrupted commit.
export class SourceRevertStore {
  readonly #journal: SignedSessionJournal<Envelope>;
  constructor(root: string, key: Buffer) { this.#journal = new SignedSessionJournal(root, key, "source-reverts"); }
  forSession(projectRoot: string, projectRef: string, sessionRef: string): SourceRevertEvidenceStore {
    const matches = (root: string, run: string | null, session: string) => path.resolve(root) === path.resolve(projectRoot) && run === null && session === sessionRef;
    const history = (): SourceRevertEvidenceRecord[] => this.#journal.history(sessionRef).map(item => {
      const record = item.record;
      if (!record || record.sessionRef !== sessionRef || record.projectRef !== projectRef || record.taskId !== null || record.taskRunId !== null
        || record.action !== "source.revert" || record.idempotencyKeyDigest !== item.idempotencyKeyDigest
        || !["requested", "settled", "rejected", "uncertain"].includes(record.phase)) throw new Error("revert-evidence-invalid");
      return record;
    });
    return {
      read: (root, run, session) => {
        if (!matches(root, run, session)) return { records: [], corruptions: ["revert-evidence-binding-mismatch"] };
        try { return { records: history(), corruptions: [] }; }
        catch { return { records: [], corruptions: ["revert-evidence-unavailable"] }; }
      },
      append: (value: SourceRevertEvidenceAppend) => {
        if (!matches(value.projectRoot, value.taskRunId, value.sessionRef) || value.taskId !== null || value.projectRef !== projectRef
          || value.action !== "source.revert") throw new Error("revert-evidence-binding-mismatch");
        const records = history(), previous = records.find(record => record.idempotencyKeyDigest === value.idempotencyKeyDigest || record.commandId === value.commandId);
        if (previous && (previous.commandId !== value.commandId || previous.idempotencyKeyDigest !== value.idempotencyKeyDigest
          || previous.actionDigest !== value.actionDigest || previous.runtimeInstanceId !== value.runtimeInstanceId
          || reviewDigest(previous.target) !== reviewDigest(value.target))) throw new Error("revert-evidence-command-mismatch");
        if (value.phase === "requested" ? !!previous : !previous || previous.phase !== "requested") throw new Error("revert-evidence-phase-invalid");
        const { projectRoot: _root, ...fields } = value;
        const sequence = Math.max(0, ...records.map(record => record.sequence)) + 1;
        const core = { ...fields, schemaVersion: 1 as const, version: "piagent-webui-source-mutation-evidence-v1" as const, sequence,
          retentionUntil: new Date(Date.parse(value.recordedAt) + 30 * 86400000).toISOString() };
        const digest = reviewDigest(core), record: SourceRevertEvidenceRecord = { ...core,
          recordId: `source-revert.${digest.slice(7)}`, evidenceRef: `source-revert.${digest.slice(7)}`, integrityDigest: digest };
        this.#journal.append(sessionRef, { identity: { sessionRef }, idempotencyKeyDigest: value.idempotencyKeyDigest, record });
        return record;
      }
    };
  }
}
