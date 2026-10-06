import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Skills and commands a member already keeps for coding agents, read by
// Piagent too: a project's own, from the project folder up to its repository
// root, and the member's in the home folder. Skills are Agent Skills folders
// (SKILL.md); commands are Markdown prompts used as /name. Only these folders
// are read from the provider folders (.claude, .codex): nothing else there.
// `pi`: folders Pi reads by itself; a runtime with Pi's own discovery leaves
// them out.
const PROJECT_SKILLS = [['.pi/skills', 'pi'], ['.agents/skills', 'pi'], ['.claude/skills'], ['.codex/skills']];
const USER_SKILLS = [['.pi/agent/skills', 'pi'], ['.agents/skills', 'pi'], ['.claude/skills'], ['.codex/skills']];
const PROJECT_COMMANDS = [['.pi/prompts', 'pi'], ['.claude/commands']];
const USER_COMMANDS = [['.pi/agent/prompts', 'pi'], ['.claude/commands'], ['.codex/prompts']];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 400;

function folder(file) {
  try { return fs.statSync(file).isDirectory() ? fs.realpathSync(file) : null; } catch { return null; }
}

// The project folder and its parents up to the repository root (the first
// folder holding .git), at most 12 levels, never the home folder or above it.
export function projectFolders(cwd, home = os.homedir()) {
  const folders = [], stop = fs.realpathSync(home);
  for (let dir = fs.realpathSync(cwd), depth = 0; depth < 12; depth += 1) {
    if (dir === stop || dir === path.dirname(dir) || (stop + path.sep).startsWith(dir + path.sep)) break;
    folders.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    dir = path.dirname(dir);
  }
  return folders;
}

// A command folder with its subfolders (.claude/commands/frontend/x.md is /x).
function commandFolders(root, depth = 0) {
  const folders = [root];
  if (depth >= 3) return folders;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.isDirectory()) folders.push(...commandFolders(path.join(root, entry.name), depth + 1));
    }
  } catch { /* unreadable */ }
  return folders;
}

export function agentResourcePaths({ cwd, home = os.homedir(), piDefaults = true }) {
  const keep = ([, owner]) => piDefaults || owner !== 'pi';
  const projects = projectFolders(cwd, home);
  const found = (bases, entries) => bases.flatMap((base) => entries.filter(keep).map(([dir]) => folder(path.join(base, dir))).filter(Boolean));
  const unique = (list) => [...new Set(list)];
  return {
    skillPaths: unique([...found(projects, PROJECT_SKILLS), ...found([home], USER_SKILLS)]),
    promptPaths: unique([...found(projects, PROJECT_COMMANDS), ...found([home], USER_COMMANDS)].flatMap((root) => commandFolders(root))),
  };
}

// The member's own skill folders (for read access: a skill's files are read
// where it is installed).
export function userSkillFolders(home = os.homedir()) {
  return USER_SKILLS.map(([dir]) => folder(path.join(home, dir))).filter(Boolean);
}

// Frontmatter fields as text: `key: value`, quoted values, and | or >
// blocks. Enough to list a skill or command; Pi parses the files it loads.
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields = {}, body = match ? text.slice(match[0].length) : text;
  if (!match) return { fields, body };
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index].trim());
      value = block.filter(Boolean).join(field[2].startsWith('>') ? ' ' : '\n');
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[field[1]] = value;
  }
  return { fields, body };
}

function readSmall(file) {
  try { return fs.statSync(file).size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8').replace(/^﻿/, '') : null; } catch { return null; }
}

function origin(file, home) {
  const name = /(?:^|\/)\.(claude|codex|agents|pi)\//.exec(file)?.[1] ?? 'pi';
  return { origin: name, scope: file.startsWith(`${fs.realpathSync(home)}${path.sep}.`) ? 'user' : 'project' };
}

function skillFiles(root, depth = 0, files = []) {
  if (files.length >= MAX_ENTRIES || depth > 4) return files;
  const own = path.join(root, 'SKILL.md');
  if (fs.existsSync(own)) { files.push(own); return files; }
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(root, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) try { isDirectory = fs.statSync(full).isDirectory(); } catch { continue; }
      if (isDirectory) skillFiles(full, depth + 1, files);
    }
  } catch { /* unreadable */ }
  return files;
}

// What a / in the composer offers: commands (/name) and skills (/skill:name),
// the first of a name winning (project before the member's), as Pi loads them.
export function listAgentCommands({ cwd, home = os.homedir() }) {
  const { skillPaths, promptPaths } = agentResourcePaths({ cwd, home });
  const items = [], seen = new Set();
  for (const root of promptPaths) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || items.length >= MAX_ENTRIES) continue;
      const file = path.join(root, entry.name), text = readSmall(file), name = entry.name.slice(0, -3);
      if (text === null || seen.has(`command:${name}`)) continue;
      seen.add(`command:${name}`);
      const { fields, body } = frontmatter(text);
      const description = fields.description || body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
      items.push({ kind: 'command', name, description: description.slice(0, 300), argumentHint: fields['argument-hint'] || null, ...origin(file, home) });
    }
  }
  for (const root of skillPaths) {
    for (const file of skillFiles(root)) {
      const text = readSmall(file); if (text === null) continue;
      const { fields } = frontmatter(text), name = fields.name || path.basename(path.dirname(file));
      // Pi loads no skill without a description.
      if (!fields.description || seen.has(`skill:${name}`)) continue;
      seen.add(`skill:${name}`);
      items.push({ kind: 'skill', name, description: fields.description.slice(0, 300), argumentHint: fields['argument-hint'] || null, ...origin(file, home) });
    }
  }
  return items;
}
