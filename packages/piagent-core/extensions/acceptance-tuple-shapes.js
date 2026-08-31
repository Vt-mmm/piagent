// Closed literal shapes used by the tuple evidence reader. These inspect
// already-sanitized text and parsed argument ranges; they never run test code.
export const INVALID_DATE_CONSTRUCTION = /^new\s+date\s*\(\s*(?:undefined|-?(?:number\.)?(?:nan|positive_infinity|negative_infinity|infinity)|__pi_(?:empty|whitespace|unparseable_date)_string_literal__)\s*\)$/i;

export function tupleRegistrationIsClosed(args) {
  if (!/^(?:async\s+)?\(\s*\)\s*=>/.test(args.at(-1)?.text ?? "")) return false;
  if (args.length === 2) return true;
  if (args.length !== 3 || !/^\{[^{}]*\}$/.test(args[1].text)) return false;
  const fields = args[1].text.slice(1, -1).split(",").map((value) => value.trim());
  if (fields.at(-1) === "") fields.pop();
  return new Set(fields).size === fields.length && fields.every((field) => /^(?:skip|todo)\s*:\s*false$/.test(field));
}
