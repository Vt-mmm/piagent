import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import { projectRefForCwd } from "./session-catalog.ts";

const VERSION = "piagent-project-registry-v1";
const MAX_PROJECTS = 200;
const MAX_BYTES = 256 * 1024;

type ProjectRecord = { projectRef: string; cwd: string; label: string; importedAt: string };
type RegistryFile = { version: typeof VERSION; projects: ProjectRecord[] };
export type ProjectProjection = { projectRef: string; placeRef: string; label: string };

function cleanLabel(value: string): string {
  return (redactSensitiveText(value).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || "Project").slice(0, 120);
}

function validRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<ProjectRecord>;
  return Object.keys(item).every((key) => ["projectRef", "cwd", "label", "importedAt"].includes(key))
    && typeof item.projectRef === "string" && /^project_[A-Za-z0-9_-]{40,80}$/.test(item.projectRef)
    && typeof item.cwd === "string" && path.isAbsolute(item.cwd) && item.cwd.length <= 4_096
    && typeof item.label === "string" && item.label.length > 0 && item.label.length <= 120 && !/[\u0000-\u001f\u007f]/.test(item.label)
    && typeof item.importedAt === "string" && Number.isFinite(Date.parse(item.importedAt));
}

export class ProjectRegistry {
  readonly file: string;
  readonly #root: string;
  readonly #key: Buffer;

  constructor(root: string, key: Buffer) {
    this.#root = root;
    this.#key = key;
    this.file = path.join(root, "projects.json");
  }

  #read(): RegistryFile {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); }
    catch { return { version: VERSION, projects: [] }; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("project-registry-file-invalid");
    const descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("project-registry-file-race");
      const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Partial<RegistryFile>;
      if (value.version !== VERSION || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS
        || !value.projects.every(validRecord)) throw new Error("project-registry-content-invalid");
      const refs = new Set<string>(), paths = new Set<string>();
      for (const item of value.projects) {
        if (item.projectRef !== projectRefForCwd(this.#key, item.cwd) || refs.has(item.projectRef) || paths.has(item.cwd)) {
          throw new Error("project-registry-content-invalid");
        }
        refs.add(item.projectRef); paths.add(item.cwd);
      }
      return value as RegistryFile;
    } finally { fs.closeSync(descriptor); }
  }

  #write(value: RegistryFile): void {
    const body = Buffer.from(`${JSON.stringify(value)}\n`);
    if (body.length > MAX_BYTES) throw new Error("project-registry-limit");
    const temporary = path.join(this.#root, `.projects-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, this.file); fs.chmodSync(this.file, 0o600);
  }

  register(input: string, now = new Date()): ProjectProjection {
    if (!Number.isFinite(now.getTime())) throw new Error("project-import-time-invalid");
    const cwd = fs.realpathSync(path.resolve(input));
    const stat = fs.lstatSync(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || cwd === path.parse(cwd).root) throw new Error("project-import-folder-invalid");
    const current = this.#read(), projectRef = projectRefForCwd(this.#key, cwd);
    const existing = current.projects.find((item) => item.projectRef === projectRef);
    if (!existing) {
      if (current.projects.length >= MAX_PROJECTS) throw new Error("project-registry-limit");
      current.projects.push({ projectRef, cwd, label: cleanLabel(path.basename(cwd)), importedAt: now.toISOString() });
      this.#write(current);
    }
    const item = existing ?? current.projects.at(-1)!;
    return { projectRef: item.projectRef, placeRef: item.projectRef, label: item.label };
  }

  list(): ProjectProjection[] {
    return this.#read().projects.flatMap((item) => {
      try {
        const canonical = fs.realpathSync(item.cwd), stat = fs.lstatSync(canonical);
        return canonical === item.cwd && stat.isDirectory() && !stat.isSymbolicLink()
          ? [{ projectRef: item.projectRef, placeRef: item.projectRef, label: item.label }] : [];
      } catch { return []; }
    });
  }

  resolve(projectRef: string): string | null {
    const item = this.#read().projects.find((candidate) => candidate.projectRef === projectRef);
    if (!item) return null;
    try {
      const canonical = fs.realpathSync(item.cwd), stat = fs.lstatSync(canonical);
      return canonical === item.cwd && stat.isDirectory() && !stat.isSymbolicLink() ? canonical : null;
    } catch { return null; }
  }
}
