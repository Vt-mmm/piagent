import { memberQuestions } from "../../piagent-core/managed/member-questions.mjs";

// The main agent's questions to the member of a conversation this Gateway
// runs: the conversation's runtime is where they are answered, and a question
// waiting for its answer keeps the running turn alive (`progress`). After a
// question is asked, answered or withdrawn, `onWaiting` hears whether one
// still waits, so other screens can announce it.
export function bindSessionQuestions(sessionId: string, progress: () => void, onWaiting: (waiting: boolean, reasonCode: string) => void): () => void {
  return memberQuestions.bindSurface(sessionId, (event: { type?: string }) => {
    progress();
    if (event?.type !== "waiting") onWaiting(memberQuestions.pending(sessionId).length > 0, `question-${event?.type ?? "changed"}`);
  });
}
export function sessionQuestions(sessionId: string | null): { questions: ReturnType<typeof memberQuestions.pending> } {
  return { questions: sessionId ? memberQuestions.pending(sessionId) : [] };
}
export function answerSessionQuestion(sessionId: string | null, questionRef: string, answer: unknown): unknown {
  if (!sessionId) throw new Error("question-not-pending");
  return memberQuestions.answer(sessionId, questionRef, answer);
}
