import fs from "node:fs";
import path from "node:path";
import { parsePiModelsJson } from "./pi-models-json.mjs";

const additions = JSON.parse(fs.readFileSync(new URL("../catalog/claude-model-additions.json", import.meta.url), "utf8"));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Explicit model-scope setup only. Keep existing models, endpoints and auth;
// this metadata is not evidence that an account has access to a model.
export function prepareClaudeModelAdditions(file) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error("Unsafe model configuration path");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let data = {}, strict = true;
  if (before !== null) {
    try { ({ data, strict } = parsePiModelsJson(before)); }
    catch (error) { throw new Error(`Cannot read model configuration ${file}: ${error.message}`); }
  }
  if (!object(data) || (data.providers !== undefined && !object(data.providers))) throw new Error("Unsupported model configuration");
  data.providers ??= {};
  const provider = data.providers.anthropic ?? {};
  if (!object(provider) || (provider.models !== undefined && !Array.isArray(provider.models))) throw new Error("Unsupported Anthropic model configuration");
  // A custom endpoint is controlled by its operator; Studio supplies its own catalog.
  if (provider.baseUrl && provider.baseUrl !== "https://api.anthropic.com") return null;
  const models = provider.models ?? [];
  const missing = additions.models.filter(model => !models.some(existing => existing.id === model.id));
  if (missing.length === 0) return null;
  // Rewriting would drop the member's comments; leave the file to them.
  if (!strict) return { skipped: `${file} has comments; not adding ${missing.map(model => model.id).join(", ")} (add them by hand if wanted)`, apply() {} };
  data.providers.anthropic = { ...provider, models: [...models, ...missing] };
  return { apply() {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current !== before) throw new Error("Model configuration changed during setup");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.piagent-${process.pid}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  } };
}
