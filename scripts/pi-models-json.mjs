// Pi reads models.json leniently: a BOM, `//` line comments and trailing
// commas are allowed (Pi's stripJsonComments). Piagent reads it the same way,
// and says whether the text was plain JSON, so a writer knows it would drop
// the member's comments.
const stripComments = text => text
  .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, m => (m[0] === '"' ? m : ""))
  .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));

export function parsePiModelsJson(text) {
  const body = text.replace(/^\uFEFF/, "");
  try { return { data: JSON.parse(body), strict: true }; }
  catch { return { data: JSON.parse(stripComments(body)), strict: false }; }
}
