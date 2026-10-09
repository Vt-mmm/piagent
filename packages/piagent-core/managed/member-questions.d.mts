export type MemberQuestion = { header: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean };
export type MemberAnswer = { skipped: boolean; answers: Array<{ selected: number[]; other: string | null }> };
export type MemberQuestionEvent = { type: "asked" | "waiting" | "answered" | "withdrawn"; ref: string; reason?: string };
export function normalizeQuestions(raw: unknown): MemberQuestion[] | null;
export function normalizeAnswer(questions: MemberQuestion[], raw: unknown): MemberAnswer | null;
export function answerText(questions: MemberQuestion[], answer: MemberAnswer): string;
export const memberQuestions: {
  pulseMs: number;
  bindSurface(sessionId: string, onEvent: (event: MemberQuestionEvent) => void): () => void;
  hasSurface(sessionId: string): boolean;
  ask(input: { sessionId: string; toolCallId: string; questions: MemberQuestion[]; signal?: AbortSignal; role?: string }): Promise<MemberAnswer>;
  pending(sessionId: string): Array<{ questionRef: string; askedAt: string; role: string; questions: MemberQuestion[] }>;
  answer(sessionId: string, questionRef: string, raw: unknown): { questionRef: string; state: "answered" };
};
export function askTool(managed: unknown): unknown;
