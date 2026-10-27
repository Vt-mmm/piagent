import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Skills and commands a member installed as Claude or Codex plugins
// (superpowers, a team's own marketplace…). Each agent keeps them in its plugin
// cache, not in ~/.claude/skills or ~/.codex/skills, so they are found here:
// the plugins the agent records as installed, the newest version of each, and
// none the member turned off. A plugin names its folders in its manifest
// ("skills", "commands"); without one they are skills/ and commands/.

const MAX_PLUGINS = 200;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function folder(file) {
  try { return fs.statSync(file).isDirectory() ? fs.realpathSync.native(file) : null; } catch { return null; }
}

function children(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())).map((entry) => entry.name); }
  catch { return []; }
}

// The newest of a plugin's cached versions: by version number, then by time.
function newest(dir) {
  const parts = (name) => name.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const compare = (a, b) => {
    const x = parts(a), y = parts(b);
    for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
      if (x[index] === y[index]) continue;
      if (x[index] === undefined) return -1;
      if (y[index] === undefined) return 1;
      if (typeof x[index] === 'number' && typeof y[index] === 'number') return x[index] - y[index];
      return String(x[index]).localeCompare(String(y[index]));
    }
    return 0;
  };
  const versions = children(dir).filter((name) => folder(path.join(dir, name)));
  return versions.length ? path.join(dir, versions.sort(compare).at(-1)) : null;
}

// The folders a plugin's manifest names for one kind (a path or a list of
// paths inside the plugin), else the conventional one.
function pluginFolders(root, manifest, field, fallback) {
  const named = manifest?.[field];
  const list = typeof named === 'string' ? [named] : Array.isArray(named) ? named.filter((item) => typeof item === 'string') : [fallback];
  return list.map((item) => path.resolve(root, item)).filter((dir) => dir === root || dir.startsWith(root + path.sep)).map(folder).filter(Boolean);
}

function plugin(root, agent, name, manifestDir) {
  const real = folder(root);
  if (!real) return null;
  const manifest = readJson(path.join(real, manifestDir, 'plugin.json'));
  return { agent, name: manifest?.name || name, root: real,
    skills: pluginFolders(real, manifest, 'skills', 'skills'), commands: pluginFolders(real, manifest, 'commands', 'commands') };
}

const inside = (dir, base) => dir === base || dir.startsWith(base + path.sep);

// Claude: installed_plugins.json lists each plugin@marketplace with where
// it is installed and for which scope (a project's install counts in that
// project only); enabledPlugins in the member's and the project's settings
// turns one off with false. Plugins synced from claude.ai (Cowork) sit under
// plugins/synced. Without the list, the cache is read as it is.
function claudePlugins(home, projects) {
  const base = path.join(home, '.claude', 'plugins');
  const settings = [path.join(home, '.claude', 'settings.json'),
    ...projects.slice().reverse().flatMap((dir) => [path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json')])];
  const enabled = Object.assign({}, ...settings.map((file) => readJson(file)?.enabledPlugins).filter((value) => value && typeof value === 'object'));
  const found = [];
  const installed = readJson(path.join(base, 'installed_plugins.json'))?.plugins;
  if (installed && typeof installed === 'object') {
    for (const [key, value] of Object.entries(installed)) {
      if (enabled[key] === false) continue;
      const entries = (Array.isArray(value) ? value : [value]).filter((entry) => entry && typeof entry.installPath === 'string');
      const entry = entries.find((item) => !item.projectPath || item.scope === 'user')
        ?? entries.find((item) => { const project = folder(item.projectPath); return project && projects.some((dir) => inside(dir, project)); });
      if (entry) found.push(plugin(entry.installPath, 'claude', key.split('@')[0], '.claude-plugin'));
    }
  } else {
    for (const market of children(path.join(base, 'cache'))) {
      for (const name of children(path.join(base, 'cache', market))) {
        if (enabled[`${name}@${market}`] === false) continue;
        const version = newest(path.join(base, 'cache', market, name));
        if (version) found.push(plugin(version, 'claude', name, '.claude-plugin'));
      }
    }
  }
  for (const bucket of children(path.join(base, 'synced'))) {
    for (const name of children(path.join(base, 'synced', bucket))) found.push(plugin(path.join(base, 'synced', bucket, name), 'claude', name, '.claude-plugin'));
  }
  return found.filter(Boolean);
}

// Codex: every plugin in plugins/cache/<marketplace>/<plugin>/<version> is
// installed; config.toml turns one off with `enabled = false` under
// [plugins."plugin@marketplace"] (a remote marketplace is cached as
// <marketplace>-remote).
function codexPlugins(home) {
  const base = path.join(home, '.codex');
  let config = '';
  try { config = fs.readFileSync(path.join(base, 'config.toml'), 'utf8'); } catch { /* none */ }
  const off = new Set();
  for (const section of config.split(/^(?=\[)/m)) {
    const head = /^\[plugins\.(?:"([^"]+)"|'([^']+)'|([\w.@-]+))\]/.exec(section);
    if (head && /^\s*enabled\s*=\s*false\s*$/m.test(section)) off.add(head[1] ?? head[2] ?? head[3]);
  }
  const found = [];
  for (const market of children(path.join(base, 'plugins', 'cache'))) {
    for (const name of children(path.join(base, 'plugins', 'cache', market))) {
      if (off.has(`${name}@${market}`) || off.has(`${name}@${market.replace(/-remote$/, '')}`)) continue;
      const version = newest(path.join(base, 'plugins', 'cache', market, name));
      if (version) found.push(plugin(version, 'codex', name, '.codex-plugin'));
    }
  }
  return found.filter(Boolean);
}

// The member's plugins, Claude's first, at most MAX_PLUGINS. A plugin
// that cannot be read is left out; it never keeps a conversation from opening.
export function memberPlugins({ home = os.homedir(), projects = [] } = {}) {
  const read = (load) => { try { return load(); } catch { return []; } };
  return [...read(() => claudePlugins(home, projects)), ...read(() => codexPlugins(home))].slice(0, MAX_PLUGINS);
}
