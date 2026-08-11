import type { ModelMutationProof } from "../quality/model-mutation-proof.ts";

export type ModelMutationIdentity = { taskId: string; taskRunId: string; sessionId: string };

type AuthoredFileEvidence = ModelMutationIdentity & {
  workingTreeDigest: string;
  contentDigest: string;
};

type AuthorizedMutation = {
  identity: ModelMutationIdentity;
  toolCallId: string;
  workingTreeSnapshot: Record<string, string>;
  targetPaths: string[];
  proof: ModelMutationProof;
  rollForwardPaths: string[];
};

export type ModelMutationCompletion = { changedPaths: string[]; recordedDigests: Record<string, string> };

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").trim()).filter(Boolean))].sort();
}

function exactPaths(left: string[], right: string[]): boolean {
  const a = uniquePaths(left), b = uniquePaths(right);
  return a.length === b.length && a.every((file, index) => file === b[index]);
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return uniquePaths([...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]));
}

function sameIdentity(left: ModelMutationIdentity, right: ModelMutationIdentity): boolean {
  return left.taskId === right.taskId && left.taskRunId === right.taskRunId && left.sessionId === right.sessionId;
}

function clonedProof(proof: ModelMutationProof): ModelMutationProof {
  return {
    expectedContentDigests: Object.fromEntries(Object.entries(proof.expectedContentDigests).map(([file, values]) => [file, [...values]])),
    preContentDigests: { ...proof.preContentDigests },
    fullContentPaths: uniquePaths(proof.fullContentPaths),
    replacePaths: uniquePaths(proof.replacePaths)
  };
}

export class ModelAuthorshipState {
  readonly #reservations = new Map<string, AuthorizedMutation>();
  readonly #evidence = new Map<string, Map<string, AuthoredFileEvidence>>();

  #key(taskRunId: string, toolCallId: string): string {
    return `${taskRunId}\u0000${toolCallId}`;
  }

  #taskEvidence(taskRunId: string): Map<string, AuthoredFileEvidence> {
    let evidence = this.#evidence.get(taskRunId);
    if (!evidence) {
      evidence = new Map();
      this.#evidence.set(taskRunId, evidence);
    }
    return evidence;
  }

  reserve(
    identity: ModelMutationIdentity,
    toolCallId: string,
    workingTreeSnapshot: Record<string, string>,
    targetPaths: string[],
    proof: ModelMutationProof
  ): boolean {
    const targets = uniquePaths(targetPaths);
    const key = this.#key(identity.taskRunId, toolCallId);
    if (!identity.taskId || !identity.taskRunId || !identity.sessionId || !toolCallId || targets.length === 0 || this.#reservations.has(key)) return false;
    const boundedProof = clonedProof(proof);
    const evidence = this.#evidence.get(identity.taskRunId);
    const rollForwardPaths = boundedProof.replacePaths.filter((file) => {
      const current = evidence?.get(file);
      return targets.includes(file)
        && Boolean(current && sameIdentity(current, identity))
        && current?.workingTreeDigest === workingTreeSnapshot[file]
        && current?.contentDigest === boundedProof.preContentDigests[file];
    });
    this.#reservations.set(key, {
      identity: { ...identity }, toolCallId, workingTreeSnapshot: { ...workingTreeSnapshot },
      targetPaths: targets, proof: boundedProof, rollForwardPaths
    });
    while (this.#reservations.size > 500) this.#reservations.delete(this.#reservations.keys().next().value as string);
    return true;
  }

  complete(
    identity: ModelMutationIdentity,
    toolCallId: string,
    success: boolean,
    currentSnapshot: Record<string, string>,
    currentContentDigests: Record<string, string> = {}
  ): ModelMutationCompletion {
    const key = this.#key(identity.taskRunId, toolCallId);
    const reservation = this.#reservations.get(key);
    this.#reservations.delete(key);
    if (!reservation) return { changedPaths: [], recordedDigests: {} };
    const changed = changedPaths(reservation.workingTreeSnapshot, currentSnapshot);
    const evidence = this.#taskEvidence(reservation.identity.taskRunId);
    const proofPaths = uniquePaths([...reservation.proof.fullContentPaths, ...reservation.proof.replacePaths]);
    const invalidate = () => {
      for (const file of uniquePaths([...reservation.targetPaths, ...changed])) evidence.delete(file);
      return { changedPaths: changed, recordedDigests: {} };
    };
    if (!sameIdentity(reservation.identity, identity) || !success || changed.length === 0 || !exactPaths(changed, proofPaths)) return invalidate();
    const candidates: Array<{ file: string; workingTreeDigest: string; contentDigest: string }> = [];
    for (const file of proofPaths) {
      const workingTreeDigest = currentSnapshot[file], content = currentContentDigests[file];
      const allowed = reservation.proof.expectedContentDigests[file] ?? [];
      const eligible = reservation.proof.fullContentPaths.includes(file) || reservation.rollForwardPaths.includes(file);
      if (!eligible || !workingTreeDigest || !content || !allowed.includes(content)) return invalidate();
      candidates.push({ file, workingTreeDigest, contentDigest: content });
    }
    const recordedDigests: Record<string, string> = {};
    for (const candidate of candidates) {
      evidence.set(candidate.file, { ...reservation.identity, ...candidate });
      recordedDigests[candidate.file] = candidate.workingTreeDigest;
    }
    while (this.#evidence.size > 100) this.#evidence.delete(this.#evidence.keys().next().value as string);
    return { changedPaths: changed, recordedDigests };
  }

  digests(identity: ModelMutationIdentity, currentSnapshot?: Record<string, string>): Record<string, string> {
    const evidence = this.#evidence.get(identity.taskRunId);
    if (!evidence) return {};
    for (const [file, item] of evidence) {
      if (!sameIdentity(item, identity) || (currentSnapshot && currentSnapshot[file] !== item.workingTreeDigest)) evidence.delete(file);
    }
    return Object.fromEntries([...evidence].map(([file, item]) => [file, item.workingTreeDigest]));
  }

  invalidate(identity: ModelMutationIdentity, paths: string[]): void {
    const evidence = this.#evidence.get(identity.taskRunId);
    if (!evidence) return;
    for (const file of uniquePaths(paths)) evidence.delete(file);
  }

  clear(taskRunId: string): void {
    this.#evidence.delete(taskRunId);
    const prefix = `${taskRunId}\u0000`;
    for (const key of this.#reservations.keys()) if (key.startsWith(prefix)) this.#reservations.delete(key);
  }
}
