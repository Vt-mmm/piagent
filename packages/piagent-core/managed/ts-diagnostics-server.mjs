// Runs inside the command sandbox (ts-diagnostics.mjs starts it): the
// project's own TypeScript reports the errors of one file, one request per
// line on stdin ({id, file}), one answer per line on stdout. TypeScript 5 and
// 6 keep a language service per tsconfig/jsconfig; TypeScript 7 (the native
// compiler, which has no such JavaScript API) checks the project with its own
// tsc, fast enough to run on each change.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const [cwd] = process.argv.slice(2);
const services = new Map();
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const version = file => { try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return '0'; } };

// The nearest tsconfig.json, else jsconfig.json, inside the project.
function configFor(file) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    for (let dir = path.dirname(file); inside(cwd, dir); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
      if (dir === cwd) break;
    }
  }
  return null;
}

function serviceFor(file) {
  let manifest;
  try { manifest = createRequire(file).resolve('typescript/package.json'); } catch { return { reason: 'no-typescript' }; }
  const config = configFor(file);
  if (!config) return { reason: 'no-config' };
  if (services.has(config)) return services.get(config);
  const major = Number.parseInt(JSON.parse(fs.readFileSync(manifest, 'utf8')).version, 10);
  if (major >= 7) {
    const entry = { native: path.join(path.dirname(manifest), 'bin/tsc'), config };
    services.set(config, entry); return entry;
  }
  const ts = createRequire(file)(path.dirname(manifest));
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return { reason: 'no-config' };
  const extra = new Set();
  const host = {
    getScriptFileNames: () => [...new Set([...parsed.fileNames, ...extra])],
    getScriptVersion: version,
    getScriptSnapshot: name => fs.existsSync(name) ? ts.ScriptSnapshot.fromString(fs.readFileSync(name, 'utf8')) : undefined,
    getCurrentDirectory: () => path.dirname(config),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
  };
  const entry = { ts, config, extra, service: ts.createLanguageService(host, ts.createDocumentRegistry()) };
  services.set(config, entry);
  return entry;
}

// tsc --pretty false prints "file(line,col): error TS1234: message".
function nativeDiagnostics({ native, config }, file) {
  let output;
  try { output = execFileSync(process.execPath, [native, '--noEmit', '--pretty', 'false', '-p', config], { cwd: path.dirname(config), encoding: 'utf8', timeout: 30000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { output = String(error.stdout ?? ''); }
  const found = [], elsewhere = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
    if (!match) continue;
    const at = path.resolve(path.dirname(config), match[1]), item = { line: Number(match[2]), column: Number(match[3]), code: Number(match[4]), message: match[5].slice(0, 400) };
    if (at === file) found.push(item); else elsewhere.push({ ...item, file: path.relative(cwd, at) });
  }
  // A syntax error anywhere stops tsc before it checks types: say so rather
  // than let silence read as a clean file.
  const syntax = elsewhere.filter(item => item.code >= 1000 && item.code < 2000);
  return found.length || !syntax.length ? { diagnostics: found } : { diagnostics: [], uncheckedBecause: syntax.slice(0, 3) };
}

function diagnostics(file) {
  const entry = serviceFor(file);
  if (entry.reason) return { reason: entry.reason };
  if (entry.native) return { config: path.relative(cwd, entry.config), ...nativeDiagnostics(entry, file) };
  const { ts, service, extra, config } = entry;
  extra.add(file);
  const found = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]
    .filter(d => d.category === ts.DiagnosticCategory.Error)
    .map(d => {
      const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      return { line: at.line + 1, column: at.character + 1, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 400) };
    });
  return { config: path.relative(cwd, config), diagnostics: found };
}

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let id = null;
  try {
    const request = JSON.parse(line); id = request.id;
    const file = path.resolve(cwd, String(request.file));
    if (!inside(cwd, file)) throw new Error('outside the project');
    process.stdout.write(JSON.stringify({ id, ...diagnostics(file) }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ id, error: String(error?.message ?? error).slice(0, 300) }) + '\n'); }
});
input.on('close', () => process.exit(0));
