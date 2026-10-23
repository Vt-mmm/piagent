import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
const LIMIT = 64 * 1024;
const OMITTED = "[terminal line omitted]\r\n";
function tail(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
function sanitized(text: string): string {
  // Escape sequences must not let a credential evade the shared redactor.
  const result = redactSensitiveText(stripVTControlCharacters(text));
  return result.redacted ? result.text : text;
}
const beginsKey = (text: string) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(stripVTControlCharacters(text));
const endsKey = (text: string) => /-----END [A-Z ]*PRIVATE KEY-----/.test(stripVTControlCharacters(text));

// Complete lines are retained only after redaction. A bounded partial line is
// kept until the next chunk so splitting a credential does not defeat matching.
export class TerminalOutputBuffer {
  #history = "";
  #partial = "";
  #droppingLine = false;
  #privateKey = false;
  #truncated = false;
  append(data: string) {
    const parts = data.split("\n");
    for (let index = 0; index < parts.length; index++) {
      const complete = index < parts.length - 1, part = parts[index];
      if (this.#droppingLine) { if (complete) this.#droppingLine = false; continue; }
      this.#partial += part;
      if (beginsKey(this.#partial)) this.#privateKey = true;
      if (this.#privateKey) {
        if (endsKey(this.#partial)) { this.#privateKey = false; this.#partial = "[REDACTED_SECRET]"; }
        else if (complete) { this.#partial = ""; continue; }
      }
      if (Buffer.byteLength(this.#partial) > LIMIT) {
        this.#retain(OMITTED); this.#partial = ""; this.#truncated = true;
        this.#droppingLine = !complete; continue;
      }
      if (complete) { this.#retain(sanitized(this.#partial + "\n")); this.#partial = ""; }
    }
  }
  snapshot() {
    const pending = this.#privateKey ? "[REDACTED_SECRET]" : sanitized(this.#partial);
    const combined = this.#history + pending;
    return { text: tail(combined, LIMIT), truncated: this.#truncated || Buffer.byteLength(combined) > LIMIT };
  }
  forAgent() { const snapshot = this.snapshot(); return { ...snapshot, text: redactSensitiveText(stripVTControlCharacters(snapshot.text)).text }; }
  // Trimmed once it doubles, not on every line: a flood of short lines would
  // otherwise copy the whole 64 KB window per line.
  #retain(text: string) {
    this.#history += text;
    if (this.#history.length > 2 * LIMIT) { this.#history = tail(this.#history, LIMIT); this.#truncated = true; }
  }
}
