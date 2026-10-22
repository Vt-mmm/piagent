export const WORKSPACE_WRITE_ENTRY = 'piagent-workspace-write';
const NOTICE = 'piagent-member-edited';

// Receipts contain paths/digests, never the member's file contents. Read the
// current branch so a fork or rewind cannot deliver notes from another branch.
export function takeWorkspaceMemberEditNotice(manager) {
  const entries = manager.getBranch();
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type !== 'custom_message' || entries[index].customType !== NOTICE) continue;
    const through = entries.findIndex(entry => entry.id === entries[index].details?.throughEntryId);
    if (through >= 0 && through < index) { start = through + 1; break; }
  }
  const edits = entries.slice(start).filter(entry => entry.type === 'custom' && entry.customType === WORKSPACE_WRITE_ENTRY
    && entry.data?.phase === 'settled' && entry.data?.resultCode === 'saved');
  const paths = [...new Set(edits.map(entry => entry.data.path)
    .filter(value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)))];
  if (!paths.length) return null;
  // Delivery itself acknowledges the receipts. A failed send leaves them
  // pending; receipts appended during delivery remain for the next turn.
  return { customType: NOTICE, display: true, details: { throughEntryId: edits.at(-1).id },
    content: `Member edited ${paths.slice(0, 16).map(value => JSON.stringify(value.slice(0, 256))).join(', ')}${paths.length > 16 ? ` and ${paths.length - 16} more files` : ''}. Read their current contents before editing; earlier reads may be stale.` };
}

export function registerWorkspaceMemberEdits(pi) {
  pi.on('before_agent_start', (_event, ctx) => {
    const message = takeWorkspaceMemberEditNotice(ctx.sessionManager);
    if (message) return { message };
  });
}
