import type { KeyboardEvent } from "react";

// Enter sends; Shift+Enter is a new line. An Enter that commits text being
// composed (Vietnamese and other input methods; Safari reports it as key
// code 229) only finishes the word and never sends.
export function sendsOnEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229;
}
