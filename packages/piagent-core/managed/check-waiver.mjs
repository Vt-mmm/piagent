// The member, never the agent, may waive the repository checks the Harness
// asks for ("bỏ qua test, đẩy luôn"). Before, the member's words changed
// nothing: under verify "require" the harness sent the agent back
// max_fix_loops times anyway, while the delivery prompt already said checks
// may be "explicitly human-waived". The agent now asks with waive_checks; the
// member answers on an approval card, once, for the code as it is then. A
// later change needs its checks again. The turn still reports that no check
// passed, and says the member waived them.
import { approve } from './command-tools.mjs';

const PARAMETERS = { type: 'object', properties: {
  member_words: { type: 'string', minLength: 1, maxLength: 300, description: 'What the member said, quoted: the request to skip the checks.' },
  reason: { type: 'string', minLength: 1, maxLength: 300, description: 'Which checks are skipped and what is left unverified.' } },
required: ['member_words', 'reason'], additionalProperties: false };

const text = value => ({ content: [{ type: 'text', text: value }], details: {} });

export function waiveChecksTool(self) {
  return { name: 'waive_checks', label: 'Waive checks', parameters: PARAMETERS,
    description: 'Ask the member to confirm that the repository checks are skipped for the code as it is now. Call it only when the member asked in this conversation to skip the tests or checks (quote them in member_words); never to end a turn sooner, never on your own judgment. The member answers on an approval card. Approved: the harness stops asking for checks on this exact code, and the turn reports that no check passed and that the member waived them. Change the code after it and the checks are required again. Pushing still asks the member as always.',
    execute: async (id, args, signal, _onUpdate, ctx) => {
      const run = self.run;
      if (!run) throw Error('managed-checks-waiver-no-run: no member request is running.');
      if (run.policy?.verify === 'off') return text('The Harness asks for no checks here: nothing to waive.');
      const digest = await self.digest();
      if (digest === null) throw Error('managed-checks-waiver-unreadable: the current code cannot be read, so a waiver could not be bound to it.');
      await approve(self, id, signal, ctx, { toolName: 'waive_checks', rawAction: { digest }, commandPreview: `waive checks: ${args.member_words}`,
        provider: 'harness', requestedScope: 'checks-waiver-once', reason: String(args.reason).slice(0, 300), riskClass: 'medium',
        allowConsequence: 'The harness stops asking for checks on this exact code; the turn reports that no check passed and that you waived them.',
        denyConsequence: 'The checks stay required; the agent runs them before it finishes.' },
      { title: 'Bỏ qua kiểm tra?', body: `Bạn đã nói: "${args.member_words}"\n\nBỏ qua: ${args.reason}\n\nĐồng ý: Harness không yêu cầu chạy kiểm tra cho đúng code hiện tại; lượt này ghi là chưa có kiểm tra nào qua và bạn đã miễn. Sửa code sau đó thì phải kiểm tra lại. Push vẫn hỏi bạn như thường.\nTừ chối: vẫn phải chạy kiểm tra trước khi xong.` });
      run.waivedDigest = digest;
      return text('The member waived the checks for the code as it is now. Do not run them again unless the member asks; say in your answer that the change is unverified.');
    } };
}
