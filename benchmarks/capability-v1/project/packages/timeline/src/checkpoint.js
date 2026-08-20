export function encodeTimelineCheckpoint(state) {
  return JSON.stringify(state);
}

export function decodeTimelineCheckpoint(serialized) {
  return JSON.parse(serialized);
}
