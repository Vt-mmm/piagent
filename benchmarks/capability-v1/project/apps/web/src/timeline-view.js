export function renderTimeline(messages) {
  return messages.map((item) => item.text).join("");
}
