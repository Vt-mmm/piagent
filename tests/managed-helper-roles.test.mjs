import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELPER_ROLES, ROLE_NAMES, helperRoles, helperPrompt, webPrompt, delegateDescription, mainWebLookups, limitedWebTools } from '../packages/piagent-core/managed/helper-roles.mjs';
import { searchResultText } from '../packages/piagent-core/managed/web-search.mjs';
import { FETCH_LIMITS, fetchLimits } from '../packages/piagent-core/managed/web-fetch.mjs';
import { describeFailure, parseFailure, failureKind } from '../packages/piagent-core/runtime/managed-failure.mjs';

const manifest = configuration => ({ harness: { configuration: { main: { model_ids: ['m'] }, ...configuration } } });

test('the helpers offered are the ones the Harness enables, in Harness order, under their working names', () => {
  // The main agent says explore/scout; Studio knows them as the Harness roles scout/research.
  assert.deepEqual(ROLE_NAMES, { explore: 'scout', scout: 'research', advisor: 'advisor', general: 'general', review: 'review' });
  assert.deepEqual(HELPER_ROLES, ['scout', 'research', 'advisor', 'general', 'review']);
  assert.deepEqual(helperRoles(manifest({ review: { model_ids: ['m'] }, scout: { model_ids: ['m'] }, research: null })), ['scout', 'review']);
  assert.deepEqual(helperRoles(manifest({ general: { model_ids: ['m'] }, advisor: { model_ids: ['m'] }, verify: { model_ids: ['m'] } })), ['advisor', 'general']);
  assert.deepEqual(helperRoles(manifest({})), []);
  assert.deepEqual(helperRoles(undefined), []);
});

test('the prompt and the delegate tool describe only enabled helpers, by working name; only general changes files', () => {
  assert.equal(helperPrompt([]), '');
  const alone = helperPrompt(['research', 'review']);
  assert.match(alone, /scout helper \(delegate role "scout"\) for anything on the web .* and when understanding the task needs more reading/);
  assert.doesNotMatch(alone, /explore|general|advisor|verify/);
  const all = helperPrompt(['scout', 'research', 'advisor', 'general', 'review']);
  assert.match(all, /explore helper \(delegate role "explore"\) when understanding the task needs more reading/);
  assert.match(all, /scout helper \(delegate role "scout"\) for anything on the web/);
  assert.doesNotMatch(all, /scout helper[^.]*when understanding the task/);
  assert.match(all, /advisor helper \(delegate role "advisor"\)/);
  assert.match(all, /Make small changes yourself\. Use the general helper \(delegate role "general"\) for large work/);
  const tool = delegateDescription(['scout', 'general']);
  assert.match(tool, /^Hand work to a helper/);
  assert.match(tool, /explore: .*no web/); assert.match(tool, /general: .*own clone/);
  assert.doesNotMatch(tool, /scout:|review:|verify/);
  assert.match(delegateDescription(['research']), /scout: anything on the web .*, and before changing an area you do not know/);
});

test('an explore or general failure names its Harness role, and a helper the Harness lacks is a tool failure', () => {
  for (const role of ['scout', 'general', 'advisor']) {
    const text = describeFailure(role, 'managed-helper-failed');
    assert.match(text, new RegExp(`^Agent Watch ${role} subagent: `));
    assert.equal(parseFailure(text).role, role);
    assert.equal(parseFailure(`Error: managed-helper-failed: ${text}`).role, role);
  }
  assert.equal(failureKind('managed-helper-not-configured'), 'tool');
  assert.equal(parseFailure('managed-helper-not-configured: the company Harness has no explore subagent; use scout.').code, 'managed-helper-not-configured');
});

test('with a research helper the web is its work; a search result names the engine that answered', () => {
  assert.match(webPrompt(['research']), /you have no web tools: hand anything on the web .* to the scout helper/);
  assert.doesNotMatch(webPrompt(['research']), /use web_search/);
  assert.match(webPrompt(['review']), /use web_search for current information/);
  assert.match(webPrompt([]), /run_with_network only when a command itself needs the internet/);
  assert.match(helperPrompt(['scout', 'research']), /scout helper \(delegate role "scout"\) for anything on the web/);
  assert.match(delegateDescription(['research']), /scout: anything on the web .* you get its summary with sources/);
  const found = { answer: 'Node 24 is the active LTS.', sources: [{ title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: '' }] };
  assert.match(searchResultText(found, 'tavily'), /^Searched with Tavily through the company search pool\.\n\nNode 24 is the active LTS\./);
  assert.match(searchResultText(found, 'model-provider'), /^Searched with the model provider's own web search\./);
  assert.match(searchResultText(found), /^Node 24 is the active LTS\./);
});

test('a helper reads less of a page than the main agent', () => {
  assert.deepEqual(fetchLimits('main'), { usual: 30_000, most: 100_000 });
  for (const role of HELPER_ROLES) assert.deepEqual(fetchLimits(role), FETCH_LIMITS.helper);
  assert.deepEqual(FETCH_LIMITS.helper, { usual: 12_000, most: 20_000 });
});

test('with a research helper the main agent may keep a few quick web lookups per message', async () => {
  const of = n => ({ harness: { configuration: { workflow: { main_web_lookups: n } } } });
  assert.equal(mainWebLookups(of(2)), 2);
  for (const n of [undefined, -1, 6, 1.5, '2']) assert.equal(mainWebLookups(of(n)), 0, String(n));
  assert.match(webPrompt(['research'], 2), /use web_search or web_fetch yourself, at most 2 call\(s\) per member message; hand anything wider/);
  assert.match(webPrompt(['research'], 0), /you have no web tools/);
  let run = { webLookups: 0 }, calls = 0;
  const [search, fetch] = limitedWebTools([{ name: 'web_search', execute: async () => ++calls }, { name: 'web_fetch', execute: async () => ++calls }], () => run, 2);
  await search.execute('1', { query: 'a' }); await fetch.execute('2', { url: 'https://example.com' });
  await assert.rejects(search.execute('3', { query: 'b' }), /managed-web-lookups-spent: .*scout helper/);
  assert.equal(calls, 2);
  run = { webLookups: 0 };
  await search.execute('4', { query: 'c' });
  assert.equal(calls, 3, 'the next member message has its own lookups');
});
