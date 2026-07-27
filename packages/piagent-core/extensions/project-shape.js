import fs from "node:fs";
import path from "node:path";

// The shape of a repository, in the only terms the profiles care about: is there
// a frontend, is there a backend, and what else is sitting at the root. Both the
// runtime recommendation (`piagent_profile_options`) and the shell initialiser
// (`scripts/init-project.sh`) read it from here. They used to carry separate
// copies of the same rules, which is how `apps/backend` ended up being invisible
// to one of them for several releases.

// Directories that name a side of the stack outright. These are matched at the
// repository root and one level under each workspace root, never at arbitrary
// depth: `src/api` inside a frontend package is an HTTP client, not a backend.
const FRONTEND_DIR_NAMES = ["frontend", "web", "client", "ui"];
const BACKEND_DIR_NAMES = ["backend", "server", "api"];
const WORKSPACE_ROOTS = ["apps", "packages", "services"];

const FRONTEND_DEPENDENCIES = /"(next|react|vite|vue|svelte|astro|@angular\/core|remix)"/i;
const BACKEND_DEPENDENCIES = /"(@nestjs|express|fastify|hono|koa|apollo-server|graphql-yoga|prisma|typeorm|sequelize|drizzle-orm)"/i;
const PYTHON_BACKEND_FRAMEWORKS = /(fastapi|flask|django|litestar|starlite)/i;

const FRONTEND_MARKER_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "src/app",
  "pages",
  "public"
];
const NODE_BACKEND_MARKER_FILES = ["nest-cli.json", "prisma", "src/server", "src/api"];
// Markers that identify a backend on their own, with no manifest to lean on.
const NATIVE_BACKEND_MARKER_FILES = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "src/main/java",
  "src/main/kotlin"
];

// A workspace file can declare any number of packages. Reading a bounded number
// of them keeps a repository with hundreds of packages from turning profile
// recommendation into a directory walk.
const MAX_WORKSPACE_PACKAGES = 64;

function exists(dir, relative) {
  try {
    return fs.existsSync(path.join(dir, relative));
  } catch {
    return false;
  }
}

function readFile(dir, relative) {
  try {
    return fs.readFileSync(path.join(dir, relative), "utf8");
  } catch {
    return undefined;
  }
}

function readJson(dir, relative) {
  const text = readFile(dir, relative);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripQuotes(value) {
  return value.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

// npm and yarn put the globs in package.json, pnpm puts them in its own file.
// Both are read: a repository is free to carry either, and some carry both.
function readWorkspacePatterns(cwd) {
  const patterns = [];

  const declared = readJson(cwd, "package.json")?.workspaces;
  if (Array.isArray(declared)) {
    patterns.push(...declared);
  } else if (Array.isArray(declared?.packages)) {
    patterns.push(...declared.packages);
  }

  patterns.push(...readPnpmWorkspacePatterns(cwd));
  return patterns.filter((pattern) => typeof pattern === "string");
}

// A three-line YAML reader rather than a YAML dependency: this package ships
// with no runtime dependencies, and the shape being read is a single list of
// strings under one key.
function readPnpmWorkspacePatterns(cwd) {
  const text = readFile(cwd, "pnpm-workspace.yaml") ?? readFile(cwd, "pnpm-workspace.yml");
  if (text === undefined) return [];

  const patterns = [];
  let insidePackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      insidePackages = true;
      continue;
    }
    if (!insidePackages) continue;

    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      patterns.push(stripQuotes(item[1]));
      continue;
    }
    // A blank line stays inside the list; anything else starts the next key.
    if (line.trim().length > 0) break;
  }
  return patterns;
}

function expandWorkspacePattern(cwd, pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  // `!` excludes rather than includes, and neither an absolute path nor one that
  // climbs out of the repository is a workspace of this repository.
  if (!normalized || normalized.startsWith("!") || normalized.startsWith("/")) return [];

  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return [];

  const wildcardAt = segments.findIndex((segment) => segment.includes("*"));
  if (wildcardAt === -1) return [segments.join("/")];
  // Only a trailing wildcard is expanded. `packages/*` and `apps/**` are what
  // workspace files actually declare; anything deeper is left to the directory
  // and dependency markers instead of growing a glob engine in here.
  if (wildcardAt !== segments.length - 1) return [];

  const base = segments.slice(0, wildcardAt).join("/");
  let entries;
  try {
    entries = fs.readdirSync(base ? path.join(cwd, base) : cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => (base ? `${base}/${entry.name}` : entry.name));
}

export function readWorkspacePackageDirs(cwd) {
  const found = [];
  const seen = new Set();
  for (const pattern of readWorkspacePatterns(cwd)) {
    for (const relative of expandWorkspacePattern(cwd, pattern)) {
      if (seen.has(relative)) continue;
      if (!exists(cwd, relative)) continue;
      seen.add(relative);
      found.push(relative);
      if (found.length >= MAX_WORKSPACE_PACKAGES) return found;
    }
  }
  return found;
}

// What one directory says about itself, from its manifest and its own layout.
// Applied to the repository root and to every declared workspace package, so a
// pnpm monorepo whose packages are named `web` and `api` is read the same way a
// single-package repository is.
function directorySignals(dir) {
  const manifest = readFile(dir, "package.json");
  let frontend = false;
  let backend = false;

  if (manifest !== undefined) {
    frontend = FRONTEND_DEPENDENCIES.test(manifest);
    backend = BACKEND_DEPENDENCIES.test(manifest);
    // Node layout markers only mean something next to a manifest. `public/` and
    // `pages/` are ordinary directory names in repositories that have nothing to
    // do with a web framework.
    if (!frontend) frontend = FRONTEND_MARKER_FILES.some((marker) => exists(dir, marker));
    if (!backend) backend = NODE_BACKEND_MARKER_FILES.some((marker) => exists(dir, marker));
  }

  if (!backend) backend = NATIVE_BACKEND_MARKER_FILES.some((marker) => exists(dir, marker));

  const pyproject = readFile(dir, "pyproject.toml");
  if (pyproject !== undefined && PYTHON_BACKEND_FRAMEWORKS.test(pyproject)) backend = true;

  return { frontend, backend };
}

function shapeFromDirName(name) {
  const normalized = name.toLowerCase();
  if (FRONTEND_DIR_NAMES.includes(normalized)) return "frontend";
  if (BACKEND_DIR_NAMES.includes(normalized)) return "backend";
  return undefined;
}

export function detectProjectShape(cwd) {
  const hasPackage = exists(cwd, "package.json");
  const shape = {
    hasPackage,
    frontend: false,
    backend: false,
    data: false,
    mobile: false,
    infra: false,
    docs: false,
    workspacePackages: []
  };

  if (exists(cwd, "pubspec.yaml") || (exists(cwd, "android") && exists(cwd, "ios"))) shape.mobile = true;
  if (exists(cwd, "dbt_project.yml") || exists(cwd, "dvc.yaml") || exists(cwd, "notebooks") || exists(cwd, "data")) {
    shape.data = true;
  }
  if (exists(cwd, "Dockerfile") || exists(cwd, "docker-compose.yml") || exists(cwd, "compose.yml")
    || exists(cwd, "compose.yaml") || exists(cwd, "terraform") || exists(cwd, "infra")
    || exists(cwd, "k8s") || exists(cwd, "helm")) {
    shape.infra = true;
  }
  if (exists(cwd, "docs") || exists(cwd, "mkdocs.yml") || exists(cwd, "mint.json") || exists(cwd, "docusaurus.config.js")) {
    shape.docs = true;
  }

  // Directory names are read whether or not the root carries a package.json.
  // A Django and React repository has `frontend/` and `backend/` and no root
  // manifest at all; gating this on package.json used to hide both sides of it.
  for (const name of [...FRONTEND_DIR_NAMES, ...BACKEND_DIR_NAMES]) {
    const side = shapeFromDirName(name);
    if (exists(cwd, name)) shape[side] = true;
    for (const root of WORKSPACE_ROOTS) {
      if (exists(cwd, `${root}/${name}`)) shape[side] = true;
    }
  }

  const rootSignals = directorySignals(cwd);
  if (rootSignals.frontend) shape.frontend = true;
  if (rootSignals.backend) shape.backend = true;

  shape.workspacePackages = readWorkspacePackageDirs(cwd);
  for (const relative of shape.workspacePackages) {
    const side = shapeFromDirName(path.posix.basename(relative));
    if (side) shape[side] = true;

    const signals = directorySignals(path.join(cwd, relative));
    if (signals.frontend) shape.frontend = true;
    if (signals.backend) shape.backend = true;
  }

  return shape;
}

export function detectProfileName(cwd, intent) {
  const normalizedIntent = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  if (normalizedIntent === "be-readonly-fe") {
    return { name: "be-readonly-fe", reason: "User intent says backend should be read-only while frontend is the write target." };
  }
  if (normalizedIntent === "frontend-only") return { name: "web-frontend", reason: "User intent says frontend-only." };
  if (normalizedIntent === "backend-only") return { name: "backend-api", reason: "User intent says backend-only." };
  if (normalizedIntent === "docs") return { name: "docs", reason: "User intent says docs/docs-only." };

  const shape = detectProjectShape(cwd);

  if (shape.mobile) return { name: "mobile", reason: "Mobile markers found." };
  if (shape.frontend && shape.backend) {
    return { name: "fullstack", reason: "Frontend and backend markers both found. Pick be-readonly-fe instead if backend must be read-only." };
  }
  if (shape.frontend) return { name: "web-frontend", reason: "Frontend framework markers found." };
  if (shape.backend) return { name: "backend-api", reason: "Backend/API markers found." };
  if (shape.data) return { name: "data", reason: "Data/ETL markers found." };
  if (exists(cwd, "pyproject.toml")) return { name: "python", reason: "Python pyproject.toml found." };
  if (shape.hasPackage && exists(cwd, "tsconfig.json")) return { name: "node-typescript", reason: "Node TypeScript markers found." };
  if (shape.infra) return { name: "devops", reason: "Infrastructure markers found." };
  if (shape.docs) return { name: "docs", reason: "Documentation markers found." };
  return { name: "generic", reason: "No stronger project markers found." };
}
