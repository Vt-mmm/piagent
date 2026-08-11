export function channelFor(kind) {
  return kind === "urgent" ? "pager" : "email";
}
