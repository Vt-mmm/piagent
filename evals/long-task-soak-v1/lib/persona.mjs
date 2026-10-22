// The simulated member: answers the business decisions a scenario leaves
// open (only when asked), pushes the agent on when it stops part way, and
// says so in the scenario's language, as a real member would.

const NUDGES = {
  vi: ['tiếp tục', 'Tiếp tục đi, làm cho xong hết các mục nhé.', 'Vẫn chưa xong, em làm tiếp đến khi kiểm tra đều qua.'],
  en: ['continue', 'Please keep going until everything is finished.', 'It is still not done. Continue until all checks pass.'],
  ja: ['続けてください', '最後まで続けてください。', 'まだ終わっていません。すべてのチェックが通るまで続けてください。'],
};
const GO_ON = { vi: 'Có, cứ làm tiếp, không cần hỏi lại.', en: 'Yes, go ahead without asking again.', ja: 'はい、確認なしで続けてください。' };
const STILL_FAILING = { vi: 'Bên anh kiểm tra vẫn chưa qua:', en: 'On my side these checks still fail:', ja: 'こちらではまだ次のチェックが失敗しています:' };
const WHAT_FAILS = [/(?:mục|phần|test|check|kiểm tra) nào (?:vẫn )?(?:chưa|còn|fail|lỗi)/i, /\b(?:which|what) (?:check|test|item|part)s? (?:is |are )?(?:still )?(?:fail|not)/i, /\bwhat(?:'s| is) (?:still )?(?:failing|missing|wrong)/i, /(?:どの|何が).*(?:失敗|通って)/];
export const asksWhatFails = text => WHAT_FAILS.some(re => re.test(String(text ?? '').slice(-600)));
const YOUR_CALL = { vi: 'Em tự quyết theo hợp lý nhất, ghi rõ giả định.', en: 'Your call: pick the most reasonable option and state the assumption.', ja: 'お任せします。妥当な選択をして前提を明記してください。' };

const matches = (text, topic) => (topic ?? []).some(word => new RegExp(word, 'i').test(text));
const optionText = option => typeof option === 'string' ? option : `${option.label ?? ''} ${option.description ?? ''}`;

export class Persona {
  constructor(scenario) {
    this.language = NUDGES[scenario.language] ? scenario.language : 'en';
    this.decisions = scenario.decisions ?? [];
    this.asked = new Map(); // decision id → how it was asked: 'tool' | 'prose'
    this.unexpected = [];   // questions no decision covers
    this.nudges = 0;
  }

  nudge(kind, failing = []) {
    if (kind === 'permission_pause') return GO_ON[this.language];
    const lines = NUDGES[this.language], line = lines[Math.min(this.nudges++, lines.length - 1)];
    // Told it is done, the member tries it and says what still fails, as a
    // member reads a red check, not the hidden tests themselves.
    return kind === 'false_done' && failing.length ? `${line}\n${this.failingText(failing)}` : line;
  }
  failingText(failing) { return [STILL_FAILING[this.language], ...failing.map(f => `- ${f}`)].join('\n'); }
  // A Stop on a stall, then the member writes again: counts as its own push.
  afterStall() { return NUDGES[this.language][0]; }

  #decisionFor(text) { return this.decisions.find(d => matches(text, d.topic)); }

  // One structured question (ask_user): {question, header, options[], multiSelect}
  // → {selected: [index]} | {other: text} | {skipped: true}
  answerStructured(q) {
    const text = `${q.header ?? ''} ${q.question}`;
    const decision = this.#decisionFor(text);
    if (!decision) { this.unexpected.push(q.question); return { skipped: true }; }
    this.asked.set(decision.id, this.asked.get(decision.id) ?? 'tool');
    const pick = new RegExp(decision.option ?? '^$', 'i');
    const index = (q.options ?? []).findIndex(o => pick.test(optionText(o)));
    return index >= 0 && decision.option ? { selected: [index] } : { other: decision.reply };
  }

  // A question written in the answer text: reply to every decision it touches.
  answerProse(text) {
    const hit = this.decisions.filter(d => matches(text, d.topic));
    if (!hit.length) { this.unexpected.push(String(text).slice(-300)); return YOUR_CALL[this.language]; }
    for (const d of hit) this.asked.set(d.id, this.asked.get(d.id) ?? 'prose');
    return hit.map(d => d.reply).join('\n');
  }

  // Decisions the member had to make that the agent never asked about.
  notAsked() { return this.decisions.filter(d => d.mustAsk && !this.asked.has(d.id)).map(d => d.id); }
}
