import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { answerSessionQuestion, readSessionQuestions, type PendingQuestion, type QuestionAnswer } from "./api.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

// The main agent's questions to the member: each with numbered options and
// "Other" in the member's own words. The turn waits until the member answers,
// leaves the choice to the agent, or stops the turn.
type Choice = { selected: number[]; other: string; otherOn: boolean };
const empty = (count: number): Choice[] => Array.from({ length: count }, () => ({ selected: [], other: "", otherOn: false }));
const answered = (c: Choice) => c.selected.length > 0 || (c.otherOn && c.other.trim().length > 0);

function Card({ sessionRef, pending, locale, onDone }: { sessionRef: string; pending: PendingQuestion; locale: UiLocale; onDone(): void }) {
  const [choices, setChoices] = useState<Choice[]>(() => empty(pending.questions.length));
  const [sending, setSending] = useState<"answer" | "skip" | null>(null), [error, setError] = useState("");
  const otherInputs = useRef<Array<HTMLInputElement | null>>([]), cardRef = useRef<HTMLElement | null>(null), blocks = useRef<Array<HTMLFieldSetElement | null>>([]);
  const [active, setActive] = useState(0);
  // The card takes the member's attention when it appears: in view, and
  // number keys work at once.
  useEffect(() => { cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); cardRef.current?.focus({ preventScroll: true }); }, []);
  const update = (index: number, next: (c: Choice) => Choice) => setChoices((all) => all.map((c, i) => i === index ? next(c) : c));
  const pick = (index: number, option: number) => update(index, (c) => {
    const multi = pending.questions[index].multiSelect;
    if (!multi) return { selected: [option], other: c.other, otherOn: false };
    return { ...c, selected: c.selected.includes(option) ? c.selected.filter((n) => n !== option) : [...c.selected, option] };
  });
  const pickOther = (index: number, on = true) => {
    update(index, (c) => pending.questions[index].multiSelect ? { ...c, otherOn: on } : { selected: [], other: c.other, otherOn: on });
    if (on) setTimeout(() => otherInputs.current[index]?.focus(), 0);
  };
  const ready = choices.every(answered);
  // A number picks that option of the question in hand (the one in focus,
  // else the current one); the one after the last option is "Other". A
  // single-choice question moves on to the next one. Enter sends once every
  // question has an answer.
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT" && (event.target as HTMLInputElement).type === "text") return;
    if (event.key === "Enter") { if (ready) { event.preventDefault(); submit(); } return; }
    const focused = Number((event.target as HTMLElement).closest("fieldset")?.getAttribute("data-question") ?? NaN);
    const index = Number.isInteger(focused) ? focused : active;
    const n = Number(event.key), q = pending.questions[index], count = q.options.length;
    if (!Number.isInteger(n) || n < 1 || n > count + 1) return;
    event.preventDefault();
    if (n === count + 1) { pickOther(index, q.multiSelect ? !choices[index].otherOn : true); return; }
    pick(index, n - 1);
    if (!q.multiSelect && index + 1 < pending.questions.length) { setActive(index + 1); blocks.current[index + 1]?.focus({ preventScroll: false }); }
  };
  const send = async (answer: QuestionAnswer, kind: "answer" | "skip") => {
    setSending(kind); setError("");
    try { await answerSessionQuestion(sessionRef, pending.questionRef, answer); onDone(); }
    catch (failure) {
      setSending(null);
      setError((failure as { status?: number }).status === 409
        ? localize(locale, "Câu hỏi này đã được trả lời hoặc lượt làm việc đã dừng.", "This question was already answered or the turn stopped.")
        : localize(locale, "Chưa gửi được câu trả lời. Thử lại.", "The answer could not be sent. Try again."));
    }
  };
  const submit = () => {
    if (!ready || sending) return;
    void send({ answers: choices.map((c) => ({ selected: [...c.selected].sort((a, b) => a - b), ...(c.otherOn && c.other.trim() ? { other: c.other.trim() } : {}) })) }, "answer");
  };
  const total = pending.questions.length;
  return <article className="question-card" ref={cardRef} tabIndex={-1} onKeyDown={keys} aria-labelledby={`question-${pending.questionRef}`}>
    <header><div><p className="section-kicker">{localize(locale, "Main agent cần bạn quyết định", "The main agent needs your decision")}</p>
      <h2 id={`question-${pending.questionRef}`}>{total > 1 ? localize(locale, `${total} câu hỏi`, `${total} questions`) : localize(locale, "1 câu hỏi", "1 question")}</h2></div>
      <span className="question-hint">{localize(locale, "Bấm số để chọn · Enter để gửi", "Press a number to choose · Enter to send")}</span></header>
    {pending.questions.map((q, index) => {
      const c = choices[index], name = `${pending.questionRef}-${index}`, type = q.multiSelect ? "checkbox" : "radio";
      return <fieldset key={name} className={index === active ? "question-block active" : "question-block"} data-question={index} tabIndex={-1}
        ref={(element) => { blocks.current[index] = element; }} onFocus={() => setActive(index)}>
        <legend>{total > 1 && <span className="question-number">{index + 1}.</span>}{q.header && <span className="question-chip">{q.header}</span>}<span className="question-text">{q.question}</span></legend>
        {q.multiSelect && <p className="question-multi">{localize(locale, "Có thể chọn nhiều đáp án.", "You can choose more than one.")}</p>}
        <ol className="question-options">
          {q.options.map((option, n) => <li key={n}><label className={c.selected.includes(n) ? "selected" : undefined}>
            <input type={type} name={name} checked={c.selected.includes(n)} onChange={() => pick(index, n)} />
            <span className="option-number" aria-hidden="true">{n + 1}</span>
            <span className="option-body"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label></li>)}
          <li className="question-other"><label className={c.otherOn ? "selected" : undefined}>
            <input type={type} name={name} checked={c.otherOn} onChange={() => pickOther(index, q.multiSelect ? !c.otherOn : true)} />
            <span className="option-number" aria-hidden="true">{q.options.length + 1}</span>
            <span className="option-body"><strong>{localize(locale, "Khác", "Other")}</strong></span></label>
            {c.otherOn && <input type="text" ref={(element) => { otherInputs.current[index] = element; }} maxLength={1000} value={c.other}
              aria-label={localize(locale, `Câu trả lời khác cho câu ${index + 1}`, `Other answer to question ${index + 1}`)}
              placeholder={localize(locale, "Nhập câu trả lời của bạn", "Type your answer")}
              onChange={(event) => update(index, (prev) => ({ ...prev, other: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} />}</li>
        </ol>
      </fieldset>;
    })}
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer>
      <button type="button" className="secondary-action" disabled={Boolean(sending)} onClick={() => void send({ skipped: true }, "skip")}>
        {sending === "skip" ? localize(locale, "Đang gửi…", "Sending…") : localize(locale, "Để agent tự quyết", "Let the agent decide")}</button>
      <button type="button" className="primary-action" disabled={!ready || Boolean(sending)} onClick={submit}>
        {sending === "answer" ? localize(locale, "Đang gửi…", "Sending…") : localize(locale, "Gửi câu trả lời", "Send answer")}</button>
    </footer>
  </article>;
}

// `waiting`: the running turn shows the agent's question step; the questions
// are read then, and once when the conversation opens (a question asked
// before this page loaded).
export function QuestionPanel({ sessionRef, waiting }: { sessionRef: string; waiting: boolean }) {
  const { locale } = useUiPreferences();
  const [pending, setPending] = useState<PendingQuestion[]>([]), [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readSessionQuestions(sessionRef, controller.signal).then((value) => setPending(value.questions ?? []), () => undefined);
    return () => controller.abort();
  }, [sessionRef, waiting, tick]);
  // The question may be registered a moment after its step shows: look again
  // while the step runs and nothing is shown yet. A shown question is looked
  // at too, as it may be answered in another tab or withdrawn meanwhile.
  useEffect(() => {
    if (!waiting && !pending.length) return;
    const timer = setInterval(() => setTick((n) => n + 1), pending.length ? 4000 : 1500);
    return () => clearInterval(timer);
  }, [waiting, pending.length]);
  if (!pending.length) return null;
  return <section className="question-stack" aria-label={localize(locale, "Câu hỏi đang chờ bạn trả lời", "Questions waiting for your answer")} aria-live="polite">
    {pending.map((item) => <Card key={item.questionRef} sessionRef={sessionRef} pending={item} locale={locale}
      onDone={() => setPending((all) => all.filter((value) => value.questionRef !== item.questionRef))} />)}
  </section>;
}
