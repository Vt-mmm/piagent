import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCHMARK_BOOTSTRAP_METADATA = "PIAGENT_BENCHMARK_BOOTSTRAP_METADATA";
const RUNTIME_DEPENDENCY_KEYS = [
  "schemaVersion", "node", "platform", "packages", "resolutionRoot", "resolutionTree", "isolation", "digest"
];
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;

let cachedRuntimeBinding = { encoded: null, value: null };

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function dependencyName(specifier) {
  if (typeof specifier !== "string" || !specifier || specifier.startsWith(".") || specifier.startsWith("/")
    || specifier.startsWith("#") || specifier.includes("\\") || /^[A-Za-z][A-Za-z+.-]*:/.test(specifier)) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return PACKAGE_NAME.test(name) ? name : null;
}

function runtimeDependencyError(reason) {
  const error = new Error(`Benchmark runtime dependency binding rejected: ${reason}`);
  error.code = "BENCHMARK_RUNTIME_DEPENDENCY_BINDING_REJECTED";
  return error;
}

function parseRuntimeBinding(encoded) {
  let metadata;
  try { metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw runtimeDependencyError("metadata-malformed"); }
  const value = metadata?.runtimeDependencies;
  if (metadata?.schemaVersion !== 1 || typeof metadata.snapshotRoot !== "string" || !path.isAbsolute(metadata.snapshotRoot)
    || !exactKeys(value, RUNTIME_DEPENDENCY_KEYS) || value.schemaVersion !== 2 || value.node !== process.version
    || value.platform !== `${os.platform()}-${os.arch()}` || !record(value.packages)
    || typeof value.resolutionRoot !== "string" || !path.isAbsolute(value.resolutionRoot)
    || path.basename(value.resolutionRoot) !== "node_modules" || typeof value.isolation !== "string"
    || !/^[a-f0-9]{64}$/.test(String(value.digest ?? ""))
    || !(value.resolutionTree === null || record(value.resolutionTree))) {
    throw runtimeDependencyError("metadata-unsupported");
  }
  for (const [name, version] of Object.entries(value.packages)) {
    if (!PACKAGE_NAME.test(name) || !(version === null || typeof version === "string" && version.length > 0)) {
      throw runtimeDependencyError("package-binding-unsupported");
    }
  }
  const identity = {
    schemaVersion: value.schemaVersion,
    node: value.node,
    platform: value.platform,
    packages: value.packages,
    resolutionRoot: value.resolutionRoot,
    resolutionTree: value.resolutionTree,
    isolation: value.isolation
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if (digest !== value.digest) throw runtimeDependencyError("metadata-digest-mismatch");
  return { snapshotRoot: metadata.snapshotRoot, ...identity };
}

async function runtimeBinding() {
  const encoded = process.env[BENCHMARK_BOOTSTRAP_METADATA];
  if (!encoded) return null;
  if (cachedRuntimeBinding.encoded === encoded) return cachedRuntimeBinding.value;
  const parsed = parseRuntimeBinding(encoded);
  let snapshotRoot;
  let resolutionRoot;
  try {
    [snapshotRoot, resolutionRoot] = await Promise.all([
      fs.realpath(parsed.snapshotRoot),
      fs.realpath(parsed.resolutionRoot)
    ]);
  } catch {
    throw runtimeDependencyError("bound-root-unavailable");
  }
  const value = { ...parsed, snapshotRoot, resolutionRoot };
  cachedRuntimeBinding = { encoded, value };
  return value;
}

// The immutable benchmark candidate intentionally has no node_modules tree.
// Its bootstrap metadata binds the host dependency versions and the one root
// from which they may resolve. Redirect only a package declared by that
// binding, only for an importer inside the candidate, and then prove that the
// selected export remains inside the exact bound package root. This is much
// narrower than NODE_PATH and leaves normal dashboard/test resolution alone.
export async function resolve(specifier, context, nextResolve) {
  const name = dependencyName(specifier);
  if (!name || !process.env[BENCHMARK_BOOTSTRAP_METADATA]) return nextResolve(specifier, context);
  const binding = await runtimeBinding();
  if (!context.parentURL?.startsWith("file:")) return nextResolve(specifier, context);
  let parent;
  try { parent = await fs.realpath(fileURLToPath(context.parentURL)); }
  catch { return nextResolve(specifier, context); }
  if (!inside(binding.snapshotRoot, parent)) return nextResolve(specifier, context);
  if (!Object.hasOwn(binding.packages, name)) throw runtimeDependencyError(`package-not-declared:${name}`);
  const expectedVersion = binding.packages[name];
  if (typeof expectedVersion !== "string") throw runtimeDependencyError(`package-unavailable:${name}`);

  let packageRoot;
  let manifest;
  try {
    packageRoot = await fs.realpath(path.join(binding.resolutionRoot, ...name.split("/")));
    manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw runtimeDependencyError(`package-unreadable:${name}`);
  }
  if (!inside(binding.resolutionRoot, packageRoot) || manifest?.name !== name || manifest?.version !== expectedVersion) {
    throw runtimeDependencyError(`package-identity-mismatch:${name}`);
  }

  const resolution = await nextResolve(specifier, {
    ...context,
    parentURL: pathToFileURL(path.join(path.dirname(binding.resolutionRoot), ".piagent-benchmark-runtime-resolver.mjs")).href
  });
  if (!resolution?.url?.startsWith("file:")) throw runtimeDependencyError(`package-export-invalid:${name}`);
  let target;
  try { target = await fs.realpath(fileURLToPath(resolution.url)); }
  catch { throw runtimeDependencyError(`package-export-unreadable:${name}`); }
  if (!inside(packageRoot, target)) throw runtimeDependencyError(`package-export-escaped:${name}`);
  return resolution;
}

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
