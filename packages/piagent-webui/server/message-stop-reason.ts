// Some providers end a turn the member stopped with `stopReason: "error"` and
// the AbortError text instead of `stopReason: "aborted"`. That is a stop, not a
// model failure: showing "the model returned an error" for it tells the member
// to resend or change model after they pressed Stop themselves.
const ABORT_ERROR = /\b(?:this operation|the operation|request) was aborted\b|\bAbortError\b|^aborted$/i;

export function effectiveStopReason(message: any): string {
  const stopReason = String(message?.stopReason ?? "");
  if (stopReason === "error" && ABORT_ERROR.test(String(message?.errorMessage ?? "").trim())) return "aborted";
  return stopReason;
}
