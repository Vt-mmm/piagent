import fs from "node:fs";
import path from "node:path";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function moduleSpecifiers(source, label) {
  const values = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) values.add(match[1]);
  return [...values];
}

function resolveRelativeModule(from, specifier, label) {
  const lexical = path.resolve(path.dirname(from), specifier);
  const candidates = [lexical, `${lexical}.js`, `${lexical}.mjs`, `${lexical}.cjs`, `${lexical}.json`];
  const selected = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!selected) fail(`Suite ${label} imports a missing relative module: ${specifier}`);
  return fs.realpathSync(selected);
}

export function assertBenchmarkModuleGraphBound(entryFile, suiteRoot, label) {
  const canonicalRoot = fs.realpathSync(suiteRoot);
  const pending = [fs.realpathSync(entryFile)];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!inside(canonicalRoot, file)) fail(`Suite ${label} module escapes the frozen suite root: ${file}`);
    const extension = path.extname(file);
    if (extension === ".json") continue;
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(source, label)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        fail(`Suite ${label} imports an unbound external module: ${specifier}`);
      }
      const dependency = resolveRelativeModule(file, specifier, label);
      if (!inside(canonicalRoot, dependency)) fail(`Suite ${label} relative module escapes the frozen suite root: ${specifier}`);
      pending.push(dependency);
    }
  }
}
