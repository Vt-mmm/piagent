import crypto from "node:crypto";

import { normalizeTimelineSnapshot } from "./project.js";

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function checksum(payload) { return crypto.createHash("sha256").update(canonical(payload)).digest("hex"); }

export function encodeTimelineCheckpoint(state) {
  const payload = normalizeTimelineSnapshot(state);
  return JSON.stringify({ schemaVersion: 1, payload, checksum: checksum(payload) });
}

export function decodeTimelineCheckpoint(serialized) {
  if (typeof serialized !== "string") throw new TypeError("checkpoint must be a string");
  let value; try { value = JSON.parse(serialized); } catch { throw new TypeError("checkpoint must be JSON"); }
  if (!value || value.schemaVersion !== 1 || !value.payload || value.checksum !== checksum(value.payload)) throw new TypeError("checkpoint integrity failure");
  return normalizeTimelineSnapshot(value.payload);
}
