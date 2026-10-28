import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadPiagentThemes, piagentThemeFiles, readStyle, registerStyleCommand, styleChoices } from '../packages/piagent-core/runtime/terminal/terminal-style.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// /style: the member picks the Terminal's look among Pi's themes and
// Piagent's. Personal Pi keeps the pick in its settings; the company
// Terminal (settings in memory) keeps it in ~/.pi and puts it back.
const sdkRoot = piSdkRoot();
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function fakePi() {
  const commands = new Map(), handlers = new Map();
  return { commands, handlers, registerCommand: (name, spec) => commands.set(name, spec), on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
}
function fakeUi(themes = []) {
  const ui = { theme: { name: 'system' }, notes: [], asked: null, picked: null,
    getAllThemes: () => themes.map((name) => ({ name, path: `/x/${name}.json` })),
    setTheme: (name) => { if (!['system', 'dark', 'light', ...themes].includes(name)) return { success: false, error: 'not found' }; ui.theme = { name }; return { success: true }; },
    select: async (title, options) => { ui.asked = { title, options }; return options.find((option) => option.startsWith(ui.picked ?? '')) ?? undefined; },
    notify: (text, tone) => ui.notes.push({ text, tone }) };
  return ui;
}

test('Piagent ships its themes as a Pi package resource', () => {
  assert.deepEqual(manifest.pi.themes, ['packages/piagent-core/themes']);
  const names = piagentThemeFiles().map((file) => path.basename(file, '.json'));
  assert.deepEqual(names, ['piagent-contrast', 'piagent-focus', 'piagent-ocean', 'piagent-paper']);
  for (const file of piagentThemeFiles()) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).name, path.basename(file, '.json'));
});

test('every Piagent theme loads with the pinned host', { skip: !fs.existsSync(path.join(sdkRoot, 'package.json')) && 'pinned Pi host not installed' }, async () => {
  const themes = await loadPiagentThemes(sdkRoot);
  assert.deepEqual(themes.map((theme) => theme.name).sort(), ['piagent-contrast', 'piagent-focus', 'piagent-ocean', 'piagent-paper']);
  assert.deepEqual(themes.map((theme) => theme.appearance).sort(), ['dark', 'dark', 'dark', 'light']);
});

test('/style lists Pi\'s themes first, then Piagent\'s, each once, and switches to the pick', async () => {
  const pi = fakePi();
  registerStyleCommand(pi);
  const ui = fakeUi(['dark', 'piagent-ocean', 'piagent-paper']);
  assert.deepEqual(styleChoices(ui).map((item) => item.name), ['system', 'dark', 'light', 'piagent-ocean', 'piagent-paper']);
  ui.picked = 'piagent-ocean';
  await pi.commands.get('style').handler('', { hasUI: true, ui });
  assert.match(ui.asked.title, /đang: system/);
  assert.equal(ui.theme.name, 'piagent-ocean');
  await pi.commands.get('style').handler('light', { hasUI: true, ui });
  assert.equal(ui.theme.name, 'light');
  await pi.commands.get('style').handler('neon', { hasUI: true, ui });
  assert.equal(ui.theme.name, 'light');
  assert.match(ui.notes.at(-1).text, /Không có giao diện "neon"/);
  // Personal Pi keeps the pick itself: no session_start hook.
  assert.equal(pi.handlers.has('session_start'), false);
  assert.deepEqual(pi.commands.get('style').getArgumentCompletions('piagent-o').map((item) => item.value), ['piagent-ocean']);
});

test('the company Terminal remembers the pick and puts it back in the next conversation', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-style-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pi = fakePi();
  registerStyleCommand(pi, { remember: true, home });
  const ui = fakeUi(['piagent-contrast']);
  await pi.commands.get('style').handler('piagent-contrast', { hasUI: true, ui });
  assert.equal(readStyle(home), 'piagent-contrast');
  const next = fakeUi(['piagent-contrast']);
  for (const handler of pi.handlers.get('session_start')) await handler({}, { hasUI: true, ui: next });
  assert.equal(next.theme.name, 'piagent-contrast');
  // The dashboard's runtime UI draws its own page.
  const gateway = Object.assign(fakeUi(['piagent-contrast']), { [Symbol.for('piagent.webui.gateway-runtime-ui.v1')]: true });
  for (const handler of pi.handlers.get('session_start')) await handler({}, { hasUI: true, ui: gateway });
  assert.equal(gateway.theme.name, 'system');
});
