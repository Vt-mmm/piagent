import { memberQuestions } from "../../piagent-core/managed/member-questions.mjs";

// The main agent's questions to the member of a conversation this Gateway
// runs: the conversation's runtime is where they are answered, and a question
// waiting for its answer keeps the running turn alive (`progress`).
export function bindSessionQuestions(sessionId: string, progress: () => void): () => void {
  return memberQuestions.bindSurface(sessionId, progress);
}
export function sessionQuestions(sessionId: string | null): { questions: ReturnType<typeof memberQuestions.pending> } {
  return { questions: sessionId ? memberQuestions.pending(sessionId) : [] };
}
export function answerSessionQuestion(sessionId: string | null, questionRef: string, answer: unknown): unknown {
  if (!sessionId) throw new Error("question-not-pending");
  return memberQuestions.answer(sessionId, questionRef, answer);
}
