import fs from 'node:fs';
import path from 'node:path';
import { discoverDeliveryContext } from './delivery-context.mjs';

// Checks come from the repository: a "## Checks" section in AGENTS.md (code
// block lines or `command` bullets), else what its manifests imply.
const HEADING = /^#{1,6}\s+(checks?|verification|kiểm tra)\s*$/i;
export function declaredChecks(agentsFiles = []) {
  const out = [];
  for (const file of agentsFiles) {
    let inside = false, fence = false;
    for (const line of String(file.content ?? '').split('\n')) {
      if (!fence && /^#{1,6}\s/.test(line)) { inside = HEADING.test(line.trim()); continue; }
      if (!inside) continue;
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const command = (fence ? line : line.match(/^\s*[-*]\s+`([^`]+)`/)?.[1] ?? '').trim();
      if (command && !command.startsWith('#') && command.length <= 200 && !out.includes(command) && out.length < 10) out.push(command);
    }
  }
  return out;
}
export function detectedChecks(dir) {
  const has = name => { try { const s = fs.lstatSync(path.join(dir, name)); return s.isFile() && s.size <= 1024 * 1024; } catch { return false; } };
  const out = [];
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
      const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
      for (const name of ['typecheck', 'type-check', 'lint', 'test', 'test:unit', 'test:integration', 'test:api', 'test:contract', 'test:e2e']) if (typeof scripts[name] === 'string') out.push(name === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${name}`);
    } catch { /* not JSON: nothing implied */ }
  }
  if (has('go.mod')) out.push('go vet ./...', 'go test ./...');
  if (has('Package.swift')) out.push('swift build', 'swift test');
  if (has('Cargo.toml')) out.push('cargo check', 'cargo test');
  if (has('pyproject.toml') || has('pytest.ini')) out.push(has('uv.lock') ? 'uv run pytest' : 'pytest');
  if (has('pom.xml')) out.push(has('mvnw') ? './mvnw verify' : 'mvn verify');
  if (has('build.gradle') || has('build.gradle.kts')) out.push(has('gradlew') ? './gradlew test' : 'gradle test');
  return out.slice(0, 16);
}
export function repositoryChecks(agentsFiles, cwd, top = cwd) {
  const declared = declaredChecks(agentsFiles);
  if (declared.length) return { source: 'agents', commands: declared };
  const detected = detectedChecks(cwd);
  // Include package/repository-local checks even when the workspace root has a
  // lint command. These are candidates, not a request to test unrelated repos.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const nested = discoverDeliveryContext(cwd).units.filter(unit => unit.path !== '.').flatMap(unit =>
    detectedChecks(path.join(cwd, unit.path)).map(command => `cd ${quote(unit.path)} && ${command}`));
  const commands = [...new Set([...detected, ...nested])].slice(0, 64);
  return { source: 'detected', commands: commands.length || cwd === top ? commands : detectedChecks(top) };
}
// A command that verifies code: a declared check, or a known test, type,
// lint or build runner. Text tools that merely mention one do not count.
const RUNNER = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build|verify)\b|\bnode\s+--test\b|\b(tsc|vitest|jest|eslint|biome|ruff|mypy|pyright|pytest|rspec|phpunit)\b|\bplaywright\s+test\b|\bpython3?\s+-m\s+(pytest|unittest|mypy)\b|\bgo\s+(test|vet|build)\b|\bcargo\s+(test|check|clippy|build)\b|\bswift\s+(test|build)\b|\bxcodebuild\b.*\b(test|build)\b|\bmake\s+(test|check|lint)\b|\b(gradle|gradlew|mvn|mvnw)\b.*\b(test|check|verify|compile|package|build)\b|\bdotnet\s+(test|build)\b|\bdeno\s+(test|check|lint)\b/;
// Files no check covers: documentation, pictures and documents,
// and Spec Kit's .specify/ state. A turn that changed only these changed no
// code: no check is required of it (one is still reported if it ran).
const NON_CODE = /\.(md|mdx|markdown|rst|adoc|asciidoc|org|png|jpe?g|gif|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
export function nonCodePath(file) {
  const name = String(file ?? '').replaceAll('\\', '/');
  return !!name && (NON_CODE.test(name) || /(^|\/)\.specify\//.test(name) || /(^|\/)(LICENSE|NOTICE|AUTHORS|CODEOWNERS)$/.test(name));
}
export const onlyNonCode = paths => { const list = [...(paths ?? [])]; return list.length > 0 && list.every(nonCodePath); };

// A command that only reads: each part starts with a reading tool and nothing
// is written to a file. Anything else may change files. Git may name the
// repository first (git -C <folder>): a workspace folder holding several
// repositories is read that way.
const GIT_READ = String.raw`git(\s+(-C\s+('[^']*'|"[^"]*"|\S+)|-c\s+\S+|--no-pager))*\s+(status|diff|log|show|branch|ls-files|rev-parse|rev-list|blame|describe|shortlog|cat-file|for-each-ref|reflog(?!\s+(expire|delete))|remote(\s+(-v|--verbose|show|get-url)\b|$))`;
const READER = new RegExp(String.raw`^(ls|cat|head|tail|wc|grep|egrep|rg|find|fd|sed|awk|cut|sort|uniq|tr|echo|printf|pwd|which|stat|file|du|df|tree|jq|diff|cmp|basename|dirname|realpath|date|true|cd|${GIT_READ})(\b|$)`);
export function isReadOnlyCommand(command) {
  const text = String(command ?? '').trim();
  if (!text || />(?!>|\s*&\d|\s*\/dev\/null)|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\s-(delete|exec|execdir|fprint|ok)\b|\bxargs\b|\$\(|`/.test(text)) return false;
  return text.split(/&&|\|\||;|\||\n/).every(part => !part.trim() || READER.test(part.trim()));
}
export function isCheckCommand(command, declared = []) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /^(echo|printf|grep|rg|cat|sed|awk|head|tail|less|git|ls|find)\b/.test(text)) return false;
  return declared.some(d => text.includes(d)) || RUNNER.test(text);
}
