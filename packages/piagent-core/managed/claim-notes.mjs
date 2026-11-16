// The session's side of claim-scope.mjs: the repositories it works in are
// kept with the conversation, and files left out are told to the member and
// the main agent, once per repository and message.
import { claimState, restoreWorkRepos, saveWorkRepos, skippedText } from './claim-scope.mjs';

// At each member message: the repositories worked in so far; what was seen
// of other processes stays (they may still be running).
export function restoreClaims(self, manager) {
  const kept = self.claims;
  self.claims = claimState(restoreWorkRepos(manager));
  if (kept) { self.claims.foreign = kept.foreign; self.claims.last = kept.last; }
  self.claimsSaved = [...self.claims.work].sort().join('\n'); self.claimsTold = new Set();
}

export async function claimsSaved(self, skipped) {
  const manager = self.session?.sessionManager;
  if (manager) self.claimsSaved = saveWorkRepos(manager, self.claims, self.claimsSaved);
  const told = self.claimsTold ??= new Set(), fresh = new Map([...skipped].filter(([repository]) => !told.has(repository)));
  if (!fresh.size || !self.session?.sendCustomMessage) return;
  for (const repository of fresh.keys()) told.add(repository);
  try {
    await self.session.sendCustomMessage({ customType: 'agent-watch-process', display: true, content: `Harness: ${skippedText(fresh)}`,
      details: { phase: 'claim-skipped', repositories: [...fresh].map(([repository, files]) => ({ repository, files: files.length })), files: [...fresh.values()].flat().slice(0, 20) } }, { triggerTurn: false });
  } catch { /* the claim stands without the note */ }
}
