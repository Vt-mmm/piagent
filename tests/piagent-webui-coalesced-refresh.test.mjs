import assert from 'node:assert/strict';
import {test} from 'node:test';
import '../scripts/register-typescript-loader.mjs';
import {coalescedRefresh} from '../packages/piagent-webui/client/src/coalesced-refresh.ts';

// Found live: every live event refetched the session list, so busy
// conversations exceeded the 120 request/min limit and the WebUI broke.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('a burst of live events triggers one list refresh, and one more if events arrive during it', async () => {
  let calls = 0, release;
  const refresh = coalescedRefresh(() => { calls += 1; return new Promise((resolve) => { release = resolve; }); }, 20);
  for (let i = 0; i < 10; i += 1) refresh.request();
  await wait(40);
  assert.equal(calls, 1, 'the burst is coalesced');
  for (let i = 0; i < 5; i += 1) refresh.request();
  release(); await wait(40);
  assert.equal(calls, 2, 'events during a refresh queue exactly one more');
  release(); await wait(40);
  assert.equal(calls, 2);
  refresh.request(); refresh.stop(); await wait(40);
  assert.equal(calls, 2, 'nothing runs after stop');
});
