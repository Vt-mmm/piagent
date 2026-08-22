// Classification only: callers keep the original Unicode text unchanged.
// A response needs at least one rendering code point; whitespace, controls and
// Unicode default-ignorables alone cannot form a visible assistant answer.
const NON_RENDERING_CODE_POINT = /^(?:\p{White_Space}|\p{Cc}|\p{Default_Ignorable_Code_Point})$/u;
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;

export function hasVisibleText(value: string): boolean {
  for (const codePoint of value.replace(ANSI_ESCAPE, "")) if (!NON_RENDERING_CODE_POINT.test(codePoint)) return true;
  return false;
}
