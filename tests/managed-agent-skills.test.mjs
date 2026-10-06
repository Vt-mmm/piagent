import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {agentResourcePaths, listAgentCommands} from '../packages/piagent-core/runtime/resources/agent-resources.mjs';
import {expandCommand} from '../packages/piagent-core/managed/agent-skills.mjs';
import {ManagedToolBoundary} from '../packages/piagent-core/managed/tool-boundary.mjs';
import {ManagedSession} from '../packages/piagent-core/managed/session.mjs';

// Skills and commands a member keeps for coding agents (the project's
// .claude/.codex/.agents/.pi folders and the same in the home folder) are
// Piagent's too: listed to the model, expanded from /name, and readable in
// the company sandbox where they are installed, nothing else of those folders.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); };
const text = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('');

function machine() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-skills-')));
  const repo = path.join(base, 'shop'), app = path.join(repo, 'apps/web'), home = path.join(base, 'home');
  write(path.join(repo, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Deploy the shop to staging or production. Use when asked to ship.\n---\nRun `scripts/ship.sh <env>` and report the URL.\n');
  write(path.join(repo, '.claude/skills/deploy/scripts/ship.sh'), '#!/bin/sh\necho shipped\n');
  write(path.join(repo, '.claude/commands/review.md'), '---\ndescription: Review the staged changes\nargument-hint: "[focus]"\n---\nReview the staged diff. Focus on ${1:-correctness}.\n');
  write(path.join(repo, '.claude/commands/frontend/component.md'), 'Create a React component named $1.\n');
  write(path.join(repo, '.claude/settings.local.json'), '{"permissions":{}}\n');
  write(path.join(app, 'package.json'), '{"name":"web"}\n');
  write(path.join(home, '.codex/skills/pdf/SKILL.md'), '---\nname: "pdf"\ndescription: >\n  Read and create PDF files.\n  Use for any PDF task.\n---\nUse `pdftotext`.\n');
  write(path.join(home, '.codex/skills/pdf/references/layout.md'), '# Layout\n');
  write(path.join(home, '.codex/skills/.system/skill-creator/SKILL.md'), '---\nname: skill-creator\ndescription: Internal.\n---\n');
  write(path.join(home, '.codex/prompts/standup.md'), 'Summarize what changed since yesterday.\n');
  write(path.join(home, '.codex/auth.json'), '{"token":"secret"}\n');
  write(path.join(home, '.claude/settings.json'), '{"env":{"TOKEN":"secret"}}\n');
  write(path.join(home, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: The member\'s own deploy skill.\n---\nPersonal.\n');
  execFileSync('git', ['init', '-q', repo]);
  return {base, repo, app, home};
}

test('skills and commands of the project (up to its repository root) and of the member are found, project first', () => {
  const {base, repo, app, home} = machine();
  try {
    const paths = agentResourcePaths({cwd: app, home});
    assert.deepEqual(paths.skillPaths, [path.join(repo, '.claude/skills'), path.join(home, '.claude/skills'), path.join(home, '.codex/skills')]);
    assert.deepEqual(paths.promptPaths, [path.join(repo, '.claude/commands'), path.join(repo, '.claude/commands/frontend'), path.join(home, '.codex/prompts')]);
    const listed = listAgentCommands({cwd: app, home}).map((item) => `${item.kind}:${item.name}:${item.origin}/${item.scope}`);
    assert.deepEqual(listed, ['command:review:claude/project', 'command:component:claude/project', 'command:standup:codex/user',
      'skill:deploy:claude/project', 'skill:pdf:codex/user'], 'the project skill wins over the member\'s; Codex system skills stay out');
    const review = listAgentCommands({cwd: app, home}).find((item) => item.name === 'review');
    assert.deepEqual([review.description, review.argumentHint], ['Review the staged changes', '[focus]']);
    assert.equal(listAgentCommands({cwd: app, home}).find((item) => item.name === 'pdf').description, 'Read and create PDF files. Use for any PDF task.');
    // A runtime with Pi's own discovery is not handed Pi's folders twice.
    write(path.join(repo, '.agents/skills/lint/SKILL.md'), '---\nname: lint\ndescription: Lint.\n---\n');
    assert.ok(agentResourcePaths({cwd: app, home}).skillPaths.includes(path.join(repo, '.agents/skills')));
    assert.ok(!agentResourcePaths({cwd: app, home, piDefaults: false}).skillPaths.includes(path.join(repo, '.agents/skills')));
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('/command, /skill:name and /skill-name expand as Pi does; other text is left as typed', async () => {
  const templates = await import(path.join(sdkRoot, 'dist/core/prompt-templates.js'));
  const api = await import(path.join(sdkRoot, 'dist/index.js'));
  const {base, repo} = machine();
  try {
    const skills = api.loadSkills({cwd: repo, agentDir: repo, skillPaths: [path.join(repo, '.claude/skills')], includeDefaults: false}).skills;
    const prompts = templates.loadPromptTemplates({cwd: repo, agentDir: repo, promptPaths: [path.join(repo, '.claude/commands')], includeDefaults: false}).templates;
    const expand = (value) => expandCommand(value, skills, prompts, api.stripFrontmatter, templates.expandPromptTemplate);
    assert.equal(expand('/review security'), 'Review the staged diff. Focus on security.');
    assert.equal(expand('/review'), 'Review the staged diff. Focus on correctness.');
    assert.match(expand('/skill:deploy staging'), /^<skill name="deploy" location="[^"]+SKILL\.md">\nReferences are relative to [^\n]+\n\nRun `scripts\/ship\.sh <env>` and report the URL\.\n<\/skill>\n\nstaging$/);
    assert.equal(expand('/deploy staging'), expand('/skill:deploy staging'), 'a skill is also /name, as other agents call it');
    for (const value of ['/tmp/build.log is empty', '/unknown thing', 'please /review', 'xin chào']) assert.equal(expand(value), value);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('the company sandbox reads a member skill where it is installed, and nothing else of the agent folders', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot)}, async () => {
  const {base, app, home} = machine();
  const boundary = new ManagedToolBoundary({cwd: app, sdkRoot, protectedRoots: [], userHome: home, skills: [path.join(home, '.codex/skills'), path.join(home, '.ssh'), home]});
  try {
    assert.match(text(await boundary.invoke('read', {path: path.join(home, '.codex/skills/pdf/SKILL.md')})), /pdftotext/);
    assert.match(text(await boundary.invoke('read', {path: '~/.codex/skills/pdf/references/layout.md'})), /Layout/);
    assert.match(text(await boundary.invoke('bash', {command: `ls ${JSON.stringify(path.join(home, '.codex/skills'))}`})), /pdf/);
    for (const closed of [path.join(home, '.codex/auth.json'), path.join(home, '.claude/settings.json')])
      await assert.rejects(boundary.invoke('read', {path: closed}), undefined, `${path.relative(home, closed)} stays closed`);
    await assert.rejects(boundary.invoke('bash', {command: `echo x >> ${JSON.stringify(path.join(home, '.codex/skills/pdf/SKILL.md'))}`}), /not permitted|managed-sandbox-denied/);
    assert.equal(fs.readFileSync(path.join(home, '.codex/skills/pdf/SKILL.md'), 'utf8').includes('x\n'), false);
    // A "skill folder" that is the home folder or a closed folder opens nothing.
    await assert.rejects(boundary.invoke('read', {path: path.join(home, '.claude/settings.json')}));
  } finally { await boundary.dispose(); fs.rmSync(base, {recursive: true, force: true}); }
});

test('a company turn lists the project skills to the model and sends a /command expanded', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const {base, repo} = machine();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const response = {id: `resp_${requests.length}`, object: 'response', status: 'in_progress', model: body.model, output: []};
    const item = {id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'OK', annotations: []}]};
    emit({type: 'response.created', response});
    emit({type: 'response.output_item.added', output_index: 0, item: {...item, content: [], status: 'in_progress'}});
    emit({type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}});
    emit({type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK'});
    emit({type: 'response.output_item.done', output_index: 0, item});
    emit({type: 'response.completed', response: {...response, status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 1, total_tokens: 11}}});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authority = {studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1}, roleID = randomUUID(), runID = randomUUID();
  const models = [{id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex'}];
  let fence = 0;
  const broker = {async request(action) {
    if (action === 'config') return {schema_version: 2, credential_mode: 'managed', authority, models, harness: {configuration: {main: {model_ids: ['gpt-6-sol']}, review: {model_ids: ['gpt-6-sol']}}}};
    if (action === 'start' || action === 'renew') return {...authority, run_id: runID, role_id: roleID, role: 'main', fence: ++fence, provider: 'codex', model_id: 'gpt-6-sol',
      provider_model_id: 'gpt-6-sol', profile_id: randomUUID(), effort: 'medium', token: `as_run_${roleID}_${'x'.repeat(43)}`};
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {}};
  const managed = await ManagedSession.create({sdkRoot, cwd: repo, origin: `http://127.0.0.1:${server.address().port}`, broker});
  try {
    managed.session.setThinkingLevel('medium');
    await managed.session.prompt('/review checkout totals');
    const system = String(requests[0].input.find((message) => message.role === 'developer')?.content ?? '');
    assert.match(system, /<name>deploy<\/name>\s*<description>Deploy the shop to staging or production\. Use when asked to ship\.<\/description>/);
    const asked = JSON.stringify(requests[0].input.filter((message) => message.role === 'user'));
    assert.match(asked, /Review the staged diff\. Focus on checkout\./, 'the command reached the model expanded');
    assert.doesNotMatch(asked, /\/review checkout/);
  } finally { await managed.dispose?.(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(base, {recursive: true, force: true}); }
});
