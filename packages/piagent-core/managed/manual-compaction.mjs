import { closeRun } from './studio-link.mjs';
import { conversationSession } from './request-stream.mjs';

// A summary asked between turns (/compact, the WebUI's button) is a request
// to Studio like any other and needs a company run: without one it failed at
// once ("no company run is active", 2026-11-13, on a conversation too long to
// continue). It opens a run of its own and closes it after; inside a turn
// the turn's run serves.
export function compactInOwnRun(owner) {
  const session = owner.session, compact = session.compact.bind(session);
  session.compact = async (...args) => {
    if (owner.grant || owner.activePrompt || owner.starting) return compact(...args);
    await owner.openRun('Summarise the earlier part of this conversation.');
    try { return await compact(...args); }
    finally {
      const manager = session.sessionManager, runId = owner.grant?.run_id;
      try {
        if (runId && await closeRun(owner.studioLink, owner.broker, owner.manifest.broker_features ?? [], null, { conversation: conversationSession(owner), runId }))
          manager.appendCustomEntry('agent-watch-run', { run_id: runId, state: 'closed' });
      } catch { /* left "active": reopening the conversation recovers or abandons it */ }
      finally { owner.grant = null; }
    }
  };
}
