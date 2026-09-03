export function deduplicateEvents(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.id, event);
  return [...latest.values()].sort((left, right) => Number(right.sequence ?? 0) - Number(left.sequence ?? 0));
}
