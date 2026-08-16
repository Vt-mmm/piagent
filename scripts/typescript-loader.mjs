import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repository TypeScript must remain erasable: the integrity lock hashes the
// source bytes and `strip` fails closed if a future change needs codegen.
// pi-mcp-adapter@2.15.0 is the sole exception because its published OAuth
// implementation contains parameter properties. Keep that transform isolated
// to the exact installed adapter root and Node release reviewed below. A Node
// or adapter upgrade must deliberately update these pins before OAuth loads.
export const PINNED_EXTERNAL_TRANSFORM = Object.freeze({
  nodeVersion: "24.11.1",
  packageName: "pi-mcp-adapter",
  packageVersion: "2.15.0"
});

async function pinnedTransformRoot(url) {
  const configured = process.env.PIAGENT_PINNED_TS_TRANSFORM_ROOT;
  if (!configured || process.versions.node !== PINNED_EXTERNAL_TRANSFORM.nodeVersion) return false;
  // This asks one question: is the file being loaded inside the pinned adapter?
  // A configured root that is absent, unreadable or not that adapter answers
  // "no". It used to throw instead, and the throw escaped `load` on the first
  // `.ts` file of any kind -- so a machine without pi-mcp-adapter installed
  // could not start the gateway at all, for a reason that had nothing to do
  // with the file it died on. Answering "no" falls back to `strip`, which is
  // the stricter of the two modes: this can only refuse a transform, never
  // grant one.
  let root;
  let metadata;
  try {
    root = await fs.realpath(configured);
    metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
  if (metadata?.name !== PINNED_EXTERNAL_TRANSFORM.packageName
    || metadata?.version !== PINNED_EXTERNAL_TRANSFORM.packageVersion) return false;
  const target = await fs.realpath(fileURLToPath(url));
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const source = await fs.readFile(new URL(url), "utf8");
  const mode = await pinnedTransformRoot(url) ? "transform" : "strip";
  return {
    format: "module",
    shortCircuit: true,
    source: stripTypeScriptTypes(source, { mode, sourceUrl: url })
  };
}
