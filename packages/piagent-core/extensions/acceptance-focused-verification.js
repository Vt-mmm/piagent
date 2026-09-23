import { isCurrentWorkingTreeDigest } from './working-tree-digest.js';
import { isWorkspaceRevisionDigest } from './workspace-revision.js';

// Recognize bounded observed test summaries; these can add obligations, never
// replace a configured verifier or independently grant acceptance proof.
export function observedFocusedTestSummary(output) {
  const text = String(output ?? '');
  return /^(?:#|ℹ)\s+tests [1-9]\d*\s*$/m.test(text)
    && /^(?:#|ℹ)\s+pass \d+\s*$/m.test(text)
    && /^(?:#|ℹ)\s+fail \d+\s*$/m.test(text);
}

export function unresolvedFocusedVerification(evidence, digest, revision) {
  const latest = new Map(), failed = new Set();
  for (const entry of evidence ?? []) {
    if (entry.observed !== true || entry.matchedProfileCommand !== false || !entry.command) continue;
    latest.set(entry.command, entry);
    if (entry.exitCode !== 0 || entry.isError === true) failed.add(entry.command);
  }
  return [...failed].filter(command => {
    const e = latest.get(command);
    return !(e.exitCode === 0 && e.isError !== true && isCurrentWorkingTreeDigest(digest)
      && isWorkspaceRevisionDigest(revision) && e.preWorkingTreeDigest === digest && e.workingTreeDigest === digest
      && e.preWorkspaceRevisionDigest === revision && e.workspaceRevisionDigest === revision);
  });
}

// Keep the recent history plus the observations needed to represent every
// unresolved focused failure. Routine successful commands cannot evict a failure.
export function retainFocusedVerification(evidence, digest, revision) {
  const unresolved = new Set(unresolvedFocusedVerification(evidence, digest, revision));
  const lastFailure = new Map(), lastObservation = new Map();
  evidence.forEach((entry, index) => {
    if (entry.observed !== true || entry.matchedProfileCommand !== false || !unresolved.has(entry.command)) return;
    lastObservation.set(entry.command, index);
    if (entry.exitCode !== 0 || entry.isError === true) lastFailure.set(entry.command, index);
  });
  const retained = new Set([...lastFailure.values(), ...lastObservation.values()]);
  return evidence.filter((_, index) => index >= evidence.length - 100 || retained.has(index));
}
