export function replayVersionedEvents(initial, events) {
  const state = initial;
  for (const event of events) {
    state.entities[event.entityId] = { version: event.expectedVersion + 1, value: event.nextValue };
    state.appliedEventIds.push(event.eventId);
  }
  return state;
}
