import crypto from "node:crypto";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be non-empty`); return value; }
function integer(value, minimum, label) { if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} is invalid`); return value; }
function eventDigest(event) {
  return crypto.createHash("sha256").update(JSON.stringify({ id: event.id, cursor: event.cursor, messageId: event.messageId, offset: event.offset, text: event.text, complete: event.complete })).digest("hex");
}

export function normalizeTimelineSnapshot(snapshot) {
  record(snapshot, "snapshot"); integer(snapshot.cursor, 0, "snapshot cursor");
  if (!Array.isArray(snapshot.messages)) throw new TypeError("messages must be an array");
  const ids = new Set();
  const messages = snapshot.messages.map((message) => {
    record(message, "message"); text(message.id, "message id");
    if (ids.has(message.id) || typeof message.text !== "string" || typeof message.complete !== "boolean") throw new TypeError("invalid message");
    ids.add(message.id); return { id: message.id, text: message.text, complete: message.complete };
  });
  record(snapshot.seen, "seen");
  const seen = {};
  for (const [id, digest] of Object.entries(snapshot.seen)) {
    text(id, "seen id");
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("invalid seen digest");
    seen[id] = digest;
  }
  return { cursor: snapshot.cursor, messages, seen };
}

export function projectTimeline(snapshot, events, options = {}) {
  const base = normalizeTimelineSnapshot(snapshot);
  if (!Array.isArray(events) || !options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("invalid projection input");
  const maxChars = options.maxChars;
  integer(maxChars, 0, "maxChars");
  const uniqueById = new Map(); const digestByCursor = new Map(); const replayEvidence = new Set();
  for (const event of events) {
    record(event, "event"); text(event.id, "event id"); text(event.messageId, "message id");
    integer(event.cursor, 1, "event cursor"); integer(event.offset, 0, "event offset");
    if (typeof event.text !== "string" || typeof event.complete !== "boolean") throw new TypeError("invalid event payload");
    const digest = eventDigest(event);
    if (uniqueById.has(event.id)) {
      if (uniqueById.get(event.id).digest !== digest) throw new TypeError("event id conflict");
      replayEvidence.add(event.id); continue;
    }
    if (digestByCursor.has(event.cursor) && digestByCursor.get(event.cursor) !== digest) throw new TypeError("cursor conflict");
    digestByCursor.set(event.cursor, digest); uniqueById.set(event.id, { event: { ...event }, digest });
  }
  const future = [];
  for (const { event, digest } of uniqueById.values()) {
    if (event.cursor <= base.cursor) {
      if (base.seen[event.id] !== digest) throw new TypeError("unknown or conflicting historical event");
      replayEvidence.add(event.id);
    } else future.push({ event, digest });
  }
  future.sort((left, right) => left.event.cursor - right.event.cursor);
  const messages = base.messages.map((item) => ({ ...item })); const byId = new Map(messages.map((item) => [item.id, item]));
  const seen = { ...base.seen }; const appliedIds = []; let cursor = base.cursor;
  let totalChars = messages.reduce((sum, item) => sum + item.text.length, 0); let gap = null; let backpressure = null; let stopIndex = future.length;
  for (let index = 0; index < future.length; index += 1) {
    const { event, digest } = future[index]; const expected = cursor + 1;
    if (event.cursor !== expected) { gap = { expected, observed: event.cursor }; stopIndex = index; break; }
    let message = byId.get(event.messageId);
    const isNewMessage = !message;
    if (!message) message = { id: event.messageId, text: "", complete: false };
    if (message.complete || event.offset !== message.text.length) throw new TypeError("invalid message continuation");
    const neededChars = totalChars + event.text.length;
    if (neededChars > maxChars) { backpressure = { eventId: event.id, cursor: event.cursor, neededChars, maxChars }; stopIndex = index; break; }
    if (isNewMessage) { messages.push(message); byId.set(event.messageId, message); }
    message.text += event.text; message.complete = event.complete; totalChars = neededChars; cursor = event.cursor; seen[event.id] = digest; appliedIds.push(event.id);
  }
  return {
    cursor, messages, seen, appliedIds, replayedIds: [...uniqueById.keys()].filter((id) => replayEvidence.has(id)),
    buffered: future.slice(stopIndex).map(({ event }) => ({ ...event })), gap, backpressure
  };
}
