import type { TerminalCommand } from "../contracts/generated/terminal-v1.ts";
import { controlActionDigest } from "./control-command-digest.ts";
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const ref = (value: unknown) => typeof value === "string" && REF.test(value);
const date = (value: unknown) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
const dimensions = (value: Record<string, unknown>) => Number.isInteger(value.cols) && Number(value.cols) >= 2 && Number(value.cols) <= 500
  && Number.isInteger(value.rows) && Number(value.rows) >= 1 && Number(value.rows) <= 200;
export function parseTerminalCommand(value: unknown): TerminalCommand {
  const invalid = () => { throw new Error("terminal-command-invalid"); };
  if (!exact(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "action", "actionDigest", "identity", "expectedRevisions", "payload"])) return invalid();
  if (value.schemaVersion !== 1 || value.version !== "piagent-terminal-v1" || value.messageType !== "command"
    || value.action !== "terminal.command" || !ref(value.commandId) || !ref(value.idempotencyKey)
    || !date(value.requestedAt) || !date(value.expiresAt)
    || !exact(value.identity, ["gatewayInstanceRef", "sessionRef", "runtimeInstanceRef"]) || !Object.values(value.identity).every(ref)
    || !exact(value.expectedRevisions, ["terminalRevision"]) || typeof value.expectedRevisions.terminalRevision !== "string"
    || !REVISION.test(value.expectedRevisions.terminalRevision) || !record(value.payload)) return invalid();
  const window = Date.parse(String(value.expiresAt)) - Date.parse(String(value.requestedAt));
  if (window < 0 || window > 300_000) return invalid();
  const payload = value.payload;
  if (payload.kind === "open") { if (!exact(payload, ["kind", "cols", "rows"]) || !dimensions(payload)) return invalid(); }
  else if (payload.kind === "input") {
    if (!exact(payload, ["kind", "terminalRef", "data"]) || !ref(payload.terminalRef) || typeof payload.data !== "string"
      || Buffer.byteLength(payload.data) > 16 * 1024) return invalid();
  } else if (payload.kind === "resize") {
    if (!exact(payload, ["kind", "terminalRef", "cols", "rows"]) || !ref(payload.terminalRef) || !dimensions(payload)) return invalid();
  } else if (payload.kind === "close") { if (!exact(payload, ["kind", "terminalRef"]) || !ref(payload.terminalRef)) return invalid(); }
  else return invalid();
  const command = value as unknown as TerminalCommand;
  if (command.actionDigest !== controlActionDigest(command)) return invalid();
  return command;
}
