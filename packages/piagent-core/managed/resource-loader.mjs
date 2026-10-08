import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
// Project instructions from the project folder up to its repository root, as
// context only (never as permission). Symlinks and large files are skipped;
// personal/global instruction files are not read.
export function projectInstructions(cwd, top = cwd) {
  const files = [];
  for (let dir = cwd, depth = 0; depth < 12; depth += 1) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && stat.size <= 64 * 1024) { files.unshift({ path: file, content: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') }); break; }
      } catch { /* absent */ }
    }
    if (dir === top || path.dirname(dir) === dir || !(dir + path.sep).startsWith(top + path.sep)) break;
    dir = path.dirname(dir);
  }
  return files.slice(-4);
}

// Managed sessions never consult the personal trust store or execute resources
// discovered in a project. Skills and commands are text (agent-skills.mjs):
// what they ask for runs with the session's own tools.
export function managedResourceLoader(api, { systemPrompt, extensions = [], runtime = api.createExtensionRuntime(), agentsFiles = [], skills = [], prompts = [] } = {}) {
  const empty = Object.freeze([]);
  return Object.freeze({
    getExtensions: () => ({ extensions, errors: empty, runtime }),
    getSkills: () => ({ skills: [...skills], diagnostics: empty }),
    getPrompts: () => ({ prompts: [...prompts], diagnostics: empty }),
    getThemes: () => ({ themes: empty, diagnostics: empty }),
    getAgentsFiles: () => ({ agentsFiles: agentsFiles.map((file) => ({ ...file })) }),
    getSystemPrompt: () => typeof systemPrompt === 'function' ? systemPrompt() : systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => empty,
    getAppendSystemPromptSources: () => empty,
    extendResources: () => { throw new Error('managed-project-resources-disabled'); },
    reload: async () => {},
  });
}

// Extensions the company Terminal adds itself (its commands and how Harness
// notes read), built the way Pi builds an inline extension. Never project code.
export async function inlineExtensions(api, sdkRoot, cwd, factories = []) {
  const runtime = api.createExtensionRuntime();
  if (!factories.length) return { extensions: [], runtime };
  const load = (file) => import(pathToFileURL(path.join(sdkRoot, 'dist', ...file.split('/'))).href);
  const [{ loadExtensionFromFactory }, { createEventBus }] = await Promise.all([load('core/extensions/loader.js'), load('core/event-bus.js')]);
  const bus = createEventBus(), extensions = [];
  for (const [index, factory] of factories.entries()) extensions.push(await loadExtensionFromFactory(factory, cwd, bus, runtime, `<inline:company-terminal-${index + 1}>`));
  return { extensions, runtime };
}
