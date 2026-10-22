// How a turn ended, seen the way a member reading the screen would see it:
// the work is done, the agent asks something the member must decide, or it
// stopped part way (the "pause" that makes members give up). The oracle, not
// the agent's own words, says whether the work is done.

const QUESTION_WORDS = [
  // vi
  /\b(?:anh|chị|bạn|em)\s+(?:muốn|chọn|thích|có muốn|cho phép|đồng ý|xác nhận)/i, /\b(?:có nên|nên chọn|hay là|phương án nào|lựa chọn nào|xác nhận giúp)\b/i,
  // en
  /\b(?:should I|shall I|do you want|would you like|which (?:option|one|approach)|please confirm|can you confirm|let me know (?:if|which|whether)|your call|prefer)\b/i,
  // ja
  /(?:どちら|しますか|よろしいですか|いかがですか|確認してください|選んでください)/,
];
const PERMISSION_TO_GO_ON = [
  /\b(?:có muốn|muốn) (?:tôi|em|mình) (?:tiếp tục|làm tiếp|tiếp)/i, /\btiếp tục (?:không|chứ|nhé)\s*\?/i,
  /\b(?:shall|should) I (?:continue|proceed|go on|keep going)\b/i, /\b(?:want|like) me to (?:continue|proceed|keep going|go ahead)\b/i,
  /続けますか|続行しますか|進めてもよろしいですか/,
];
const MIDWAY_WORDS = [
  /(?:tiếp theo (?:tôi|em|mình) sẽ|(?:tôi|em|mình) sẽ (?:tiếp tục|làm tiếp)|phần còn lại|các mục còn lại|chưa xong|chưa hoàn thành|bước tiếp theo)/i,
  /\b(?:next,? I(?:'ll| will)|I(?:'ll| will) (?:continue|now|next)|remaining (?:steps|items|work)|not (?:yet )?(?:done|finished|complete)|still (?:need|to do)|TODO)\b/i,
  /(?:次に|続いて|残りの|未完了)/,
];
const DONE_WORDS = [/(?:đã (?:làm )?xong|làm xong|xong cả|xong hết|hoàn thành|hoàn tất|xong rồi|(?:test|kiểm thử) (?:đều )?(?:pass|qua)|qua \d+\/\d+)/i, /\b(?:pass(?:ed|es)? \d+\/\d+|\d+\/\d+ (?:tests? )?pass)/i, /\b(?:done|completed|finished|all (?:tests|checks) pass(?:ed)?|implemented)\b/i, /(?:完了|終わりました|すべてのテストが通)/];

const tail = (text, n = 700) => String(text ?? '').trim().slice(-n);

// Does the agent's last text hand the member a question to answer?
export function asksMember(text) {
  const end = tail(text);
  if (!end) return false;
  const lastParagraph = end.split(/\n\s*\n/).filter(Boolean).at(-1) ?? end;
  return /[?？]\s*(?:[*_`)\]]*)\s*$/.test(lastParagraph) || /[?？]/.test(lastParagraph) && QUESTION_WORDS.some(re => re.test(lastParagraph))
    || QUESTION_WORDS.some(re => re.test(lastParagraph)) && /\n\s*(?:\d+[.)]|[-*•])\s+\S/.test(end);
}
export const asksPermissionToGoOn = text => PERMISSION_TO_GO_ON.some(re => re.test(tail(text, 400)));
export const saysMidway = text => MIDWAY_WORDS.some(re => re.test(tail(text, 600)));
export const claimsDone = text => DONE_WORDS.some(re => re.test(tail(text, 900)));

// One turn end → what the member sees and what the simulated member does next.
// turn: { lastText, turnEnd: {state}|null, error: string|null, stalled, crashed }
// oracle: { pass } | null (null when not run because the agent asked)
export function classifyTurn(turn, oracle) {
  if (turn.crashed) return { kind: 'crashed', defect: 'process_crashed' };
  if (turn.stalled) return { kind: 'stalled', defect: 'stalled_no_activity' };
  if (oracle?.pass) return { kind: 'done', defect: null };
  if (turn.error || turn.turnEnd?.state === 'failed') return { kind: 'failed', defect: 'turn_failed' };
  if (turn.turnEnd?.state === 'cancelled') return { kind: 'cancelled', defect: null };
  const text = turn.lastText ?? '';
  if (asksPermissionToGoOn(text)) return { kind: 'permission_pause', defect: 'asked_permission_to_continue' };
  if (asksMember(text)) return { kind: 'asked', defect: null };
  if (turn.turnEnd?.state === 'midway' || saysMidway(text)) return { kind: 'midway', defect: 'stopped_midway' };
  // The Harness itself closed the turn as finished: whatever the wording,
  // the agent considered the work done.
  if (claimsDone(text) || turn.turnEnd?.state === 'done') return { kind: 'false_done', defect: 'claimed_done_but_checks_fail' };
  if (!text.trim()) return { kind: 'silent', defect: 'ended_without_answer' };
  return { kind: 'midway', defect: 'stopped_midway' };
}

// Would a real member still be here? smooth: done with no help; recovered:
// done after the member pushed (a nudge, a Stop on a stall, a reopen after a
// crash); abandoned: not done, or more pushing than a member gives.
export function verdict({ pass, nudges, stalls, crashes, maxNudges }) {
  const pushes = nudges + stalls + crashes;
  if (!pass || pushes > maxNudges) return 'abandoned';
  return pushes === 0 ? 'smooth' : 'recovered';
}
