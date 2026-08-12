import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const source = await fs.readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url })
  };
}
