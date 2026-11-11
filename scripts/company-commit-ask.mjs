// /commit-ask: in Always bypass, the member stops (or brings back) the
// question before each commit, for this conversation only (owner, 2026-11-11).
// A push, a merge and an rm on a critical path are asked still; the other
// modes never read the switch (managed/permission.mjs).
import { effectivePermission } from '../packages/piagent-core/managed/permission.mjs';

export const COMMIT_ASK_TEXT = {
  on: 'Always bypass hỏi trước mỗi commit (mặc định).',
  off: 'Always bypass commit không hỏi trong cuộc trò chuyện này. Push, merge và xoá đường dẫn quan trọng vẫn hỏi. Bật lại: /commit-ask on.',
  other: 'Chỉ áp dụng khi cuộc trò chuyện ở Always bypass (/bypass always). Các quyền khác vẫn hỏi như cũ.',
};

// What the member reads after the command: the switch, and whether it applies now.
export function commitAskNotice(owner) {
  const text = owner?.commitAsk === false ? COMMIT_ASK_TEXT.off : COMMIT_ASK_TEXT.on;
  return effectivePermission(owner) === 'always-bypass' ? text : `${text} ${COMMIT_ASK_TEXT.other}`;
}

export function registerCommitAskCommand(pi, { managed, completions, refresh }) {
  pi.registerCommand('commit-ask', {
    description: 'Always bypass: off để commit không cần hỏi trong cuộc trò chuyện này (push vẫn hỏi), on để hỏi lại, status để xem',
    getArgumentCompletions: completions(['on', 'off', 'status']),
    handler: async (args, ctx) => {
      const owner = managed();
      if (typeof owner?.session?.managedSetCommitAsk !== 'function') { ctx.ui.notify('Cuộc trò chuyện này chưa sẵn sàng.', 'error'); return; }
      const arg = args.trim().toLowerCase();
      if (!['', 'on', 'off', 'status'].includes(arg)) { ctx.ui.notify('Cách dùng: /commit-ask on|off|status', 'warning'); return; }
      if (arg === 'on' || arg === 'off') owner.session.managedSetCommitAsk(arg === 'on');
      else if (arg === '') owner.session.managedSetCommitAsk(owner.commitAsk === false);
      refresh(ctx);
      ctx.ui.notify(commitAskNotice(owner), 'info');
    } });
}
