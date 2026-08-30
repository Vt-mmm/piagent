import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const relativePath = (value) => typeof value === "string" && value.length <= 512
  && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value)
  && !value.split("/").some((part) => [".", "..", ".git"].includes(part));

export function benchmarkArtifactBindingShapeErrors(bindings) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 64) return ["artifact-bindings-invalid"];
  const ids = new Set(), paths = new Set(), errors = [];
  for (const item of bindings) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3
      || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.id)
      || !relativePath(item.path) || typeof item.sha256 !== "string" || !SHA256.test(item.sha256)
      || ids.has(item.id) || paths.has(item.path)) errors.push("artifact-binding-invalid");
    else { ids.add(item.id); paths.add(item.path); }
  }
  return errors;
}

/** Checks current source only. A historical archive can never satisfy this gate. */
export function benchmarkArtifactBindingErrors(bindings, sourceRoot) {
  const errors = benchmarkArtifactBindingShapeErrors(bindings);
  if (errors.length) return errors;
  let root;
  try {
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw new Error("Invalid root");
    root = fs.realpathSync.native(sourceRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error("Invalid root");
  } catch { return ["artifact-source-root-unavailable"]; }
  for (const item of bindings) {
    let fd;
    try {
      const file = path.join(root, item.path);
      if (fs.realpathSync.native(file) !== file) throw new Error("Symlinked artifact");
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size < 1 || before.size > 2 * 1024 * 1024) throw new Error("Invalid artifact size/type");
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) throw new Error("Artifact changed while reading");
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) errors.push(`artifact-digest-mismatch:${item.path}`);
    } catch { errors.push(`artifact-unavailable-or-unsafe:${item.path}`); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return errors;
}
