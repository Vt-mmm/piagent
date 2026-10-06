import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentResourcePaths } from '../runtime/resources/agent-resources.mjs';

// The skills and commands of the project and of the member (see
// agent-resources.mjs), loaded with Pi's own loaders: skills are listed to
// the model by name and description, commands become /name. Also the folders
// the sandbox opens for reading: a skill's SKILL.md and the files it bundles,
// where the skill is installed.
export async function loadAgentResources(api, sdk, cwd, home) {
  // A folder that cannot be read never keeps the conversation from opening.
  try { return await load(api, sdk, cwd, home); }
  catch { return { skills: [], prompts: [], readable: [], expand: (text) => text }; }
}

async function load(api, sdk, cwd, home) {
  const { skillPaths, promptPaths } = agentResourcePaths({ cwd, ...(home ? { home } : {}) });
  // Defaults off: no personal Pi folder is consulted, only these paths.
  const skills = skillPaths.length ? api.loadSkills({ cwd, agentDir: cwd, skillPaths, includeDefaults: false }).skills : [];
  const templates = await import(pathToFileURL(path.join(sdk, 'dist/core/prompt-templates.js')));
  const prompts = promptPaths.length ? templates.loadPromptTemplates({ cwd, agentDir: cwd, promptPaths, includeDefaults: false }).templates : [];
  const real = (dir) => { try { return fs.realpathSync(dir); } catch { return null; } };
  const readable = [...new Set([...skillPaths, ...skills.map((skill) => real(skill.baseDir))].filter(Boolean))];
  return { skills, prompts, readable, expand: (text) => expandCommand(text, skills, prompts, api.stripFrontmatter, templates.expandPromptTemplate) };
}

// A member's /skill:name, /command or /skill-name (as other agents call a
// skill), expanded as Pi does: a command's prompt with its arguments, or the
// skill's instructions followed by what the member asked. Anything else, a
// path such as /tmp/x included, is left as typed.
export function expandCommand(text, skills, prompts, stripFrontmatter, expandPromptTemplate) {
  if (typeof text !== 'string' || !text.startsWith('/')) return text;
  const space = text.search(/\s/), head = space < 0 ? text.slice(1) : text.slice(1, space);
  const args = space < 0 ? '' : text.slice(space + 1).trim();
  const explicit = head.startsWith('skill:'), name = explicit ? head.slice(6) : head;
  if (!explicit && prompts.some((prompt) => prompt.name === name)) return expandPromptTemplate(text, prompts);
  const skill = skills.find((item) => item.name === name);
  if (!skill) return text;
  let body;
  try { body = stripFrontmatter(fs.readFileSync(skill.filePath, 'utf8')).trim(); } catch { return text; }
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}
