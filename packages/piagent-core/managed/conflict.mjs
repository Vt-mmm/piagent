// When agents disagree and the task stops for the member (owner, 2026-11-14):
// the member reads each side, not only an id. For each disputed item: what
// the subagent concluded and its evidence (with whether the harness found the
// file:line), what the main agent decided and what it checked, and the
// advisor's recommendation in this message when it gave one. The main agent
// is then told to re-check each piece of evidence and answer with its own
// recommendation first.
import { callName } from './role-names.mjs';

const place = item => item.place === 'ok' ? ' [harness: có thật]' : item.place === 'missing' ? ' [harness: không thấy chỗ này]' : '';
const opinionsOf = run => (run?.opinions ?? []).filter(o => o.role === 'advisor').slice(-1);

export function conflictText(run, items) {
  const lines = ['Conflict — dừng để bạn quyết định:'];
  for (const item of items) {
    lines.push(`• ${item.id} · ${callName(item.role)} kết luận: ${item.detail}`);
    lines.push(`  Evidence: ${item.evidence || '(không đưa evidence)'}${place(item)}`);
    lines.push(item.resolution ? `  Main: ${item.resolution.decision === 'rejected' ? 'không đồng ý' : 'đồng ý'} — đã kiểm: ${item.resolution.checked}${item.resolution.reason ? `; lý do: ${item.resolution.reason}` : ''}` : '  Main: chưa ghi quyết định.');
  }
  for (const o of opinionsOf(run)) {
    lines.push(`• Advisor khuyến nghị: ${o.recommendation || '(không có)'}`);
    for (const e of (o.evidence ?? []).slice(0, 4)) lines.push(`  Evidence: ${e.text}${place(e)}`);
  }
  return lines.join('\n');
}

export const CONFLICT_ASK = 'Before you end, re-check each piece of evidence above yourself (read the file:line, run the command) and tell the member, side by side: what each subagent and the advisor concluded with its evidence, what you checked and found, and your recommendation as option 1. Then let them decide.';
