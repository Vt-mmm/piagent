export function projectChatEvents(events) {
  const messages = events.filter((event) => event.kind === "message").map((event) => ({ ...event }));
  return {
    messages,
    processing: events.some((event) => event.kind === "lifecycle" && event.state === "started")
  };
}
