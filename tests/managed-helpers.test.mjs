import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';

const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
const content = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');

// Real native SDK streams and actual Seatbelt workers; only provider and
// broker authority are fixtures. No user config, Keychain or live inference.
for (const changeDuringReview of [true, false]) test(`mixed-provider helpers invalidate changes ${changeDuringReview ? 'during' : 'after'} review`, {skip: !supported, timeout: 120000}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-helpers-')));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = args => execFileSync('/usr/bin/git', args, {cwd:project, encoding:'utf8'}).trim();
  git(['init', '-q']); fs.writeFileSync(path.join(project, 'source.txt'), 'before\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline']);
  const head = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(project, 'source.txt'), 'after\n');
  fs.writeFileSync(path.join(project, 'new.txt'), 'untracked fixture\n');
  const gates = Object.fromEntries(['main', 'research', 'review'].map(role => [role, {entered:deferred(), release:deferred()}]));
  const roleIDs = Object.fromEntries(Object.keys(gates).map(role => [role, randomUUID()]));
  const runID = randomUUID(), authority = {studio_instance_id:randomUUID(), dataset_epoch:randomUUID(), auth_generation:1};
  const models = [{id:'main-model', provider_model_id:'gpt-6-sol', owned_by:'codex'}, {id:'helper-model', provider_model_id:'claude-opus-5-5', owned_by:'claude'}];
  const fences = {}, calls = [], requests = [];
  const grant = role => ({...authority, run_id:runID, role_id:roleIDs[role], role, fence:fences[role]=(fences[role]??0)+1,
    token:`as_run_${roleIDs[role]}_${'x'.repeat(43)}`, model_id:role==='main'?'main-model':'helper-model', provider:role==='main'?'codex':'claude', provider_model_id:role==='main'?'gpt-6-sol':'claude-opus-5-5', effort:'medium'});
  const broker = {async request(action, args={}) {
    calls.push({action, ...args});
    if(action==='config') return {schema_version:2, credential_mode:'managed', authority, models, harness:{configuration:{main:{model_ids:['main-model']}, research:{model_ids:['helper-model']}, review:{model_ids:['helper-model']}}}};
    if(['start','renew','child'].includes(action)) return grant(args.role??'main');
    if(action==='close') return true;
    throw Error('unexpected-broker-action');
  }, async dispose() {}};
  const server = http.createServer(async(req,res) => {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const role=Object.keys(roleIDs).find(role=>roleIDs[role]===req.headers['x-session-id']);
    requests.push({role,body,agent:req.headers['user-agent']}); gates[role].entered.resolve(); await gates[role].release.promise;
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const emit = event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if(role==='main') {
      const response={id:'resp_fixture',object:'response',status:'in_progress',model:body.model,output:[]};
      emit({type:'response.created',response});
      emit({type:'response.completed',response:{...response,status:'completed',usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});
    } else {
      emit({type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:12,output_tokens:0}}});
      emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
      emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Helper fixture result'}});
      emit({type:'content_block_stop',index:0});
      emit({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});
      emit({type:'message_stop'});
    }
    res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let managed, prompt;
  try {
    managed=await ManagedSession.create({sdkRoot,cwd:project,origin:`http://127.0.0.1:${server.address().port}`,broker});
    managed.session.setThinkingLevel('medium');
    const initial=await managed.patchSnapshot();
    const patch=JSON.parse(initial.patch);
    assert.match(patch.patch, /\+after/); assert.equal(patch.untracked[0].path,'new.txt');
    // New text files reach the reviewer as text.
    assert.deepEqual([patch.untracked[0].encoding,patch.untracked[0].contents],['utf8','untracked fixture\n']);
    prompt=managed.session.prompt('Review and research this change');
    await gates.main.entered.promise;
    const research=managed.delegate({role:'research',task:'Read source.txt and report context'});
    const review=managed.delegate({role:'review',task:'Review the supplied patch'});
    await Promise.all([gates.research.entered.promise,gates.review.entered.promise]);
    await assert.rejects(managed.delegate({role:'research',task:'Duplicate'}), /unavailable/);
    assert.equal(managed.helpers.size,2);
    assert.equal(managed.session.sessionManager.getEntries().filter(e=>e.customType==='agent-watch-helpers').at(-1).data.active,2);
    const researchWire=requests.find(r=>r.role==='research').body;
    // The native adapter inserts a non-executable cache placeholder.
    const executableTools = body => (body.tools??[]).filter(t=>t.name!=='__pi_deferred_placeholder__').map(t=>t.name).sort();
    // Research helpers read the project and the web; they never write or run commands.
    assert.deepEqual(executableTools(researchWire),['find','grep','ls','read','web_fetch','web_search']);
    // A helper reads at most 20,000 characters of a page: its pages stay in its context.
    const fetchTool=researchWire.tools.find(t=>t.name==='web_fetch'), schema=fetchTool.input_schema??fetchTool.parameters;
    assert.equal(schema.properties.maxChars.maximum,20000); assert.match(fetchTool.description,/at most 20,000 characters \(12,000 unless you ask for more\)/);
    // With a research helper the main agent has no web tools: the web is the helper's work.
    const mainTools=executableTools(requests.find(r=>r.role==='main').body);
    assert.ok(!mainTools.includes('web_search') && !mainTools.includes('web_fetch') && mainTools.includes('delegate'), mainTools.join(','));
    assert.match(JSON.stringify(requests.find(r=>r.role==='main').body),/you have no web tools: hand anything on the web/);
    // Reviewers read the code around the patch; they never write, run commands or use the web.
    assert.deepEqual(executableTools(requests.find(r=>r.role==='review').body),['find','grep','ls','read']);
    assert.match(JSON.stringify(requests.find(r=>r.role==='review').body),new RegExp(initial.digest));
    if (changeDuringReview) fs.writeFileSync(path.join(project,'source.txt'),'changed during review\n');
    gates.research.release.resolve(); gates.review.release.resolve();
    const [a,b]=await Promise.all([research,review]);
    assert.equal(managed.session.sessionManager.getEntries().filter(e=>e.customType==='agent-watch-helpers').at(-1).data.active,0);
    assert.equal(a.details.runID,runID); assert.equal(a.details.tokens,15);
    assert.equal(b.details.runID,runID); assert.equal(b.details.tokens,15);
    assert.equal(b.details.stale,changeDuringReview);
    if (changeDuringReview) assert.match(content(b),/Review is stale/);
    else {
      assert.equal(managed.review.stale, false);
      await managed.session.executeBash("printf 'later change\\n' > source.txt");
      assert.equal(managed.review.stale, true);
      assert.equal(managed.session.sessionManager.getEntries().filter(e=>e.type==='custom'&&e.customType==='agent-watch-review').at(-1).data.stale,true);
    }
    assert.equal(b.details.patchDigest,initial.digest);
    // Studio names the tool from the User-Agent, on both providers' wires.
    const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version;
    assert.deepEqual([...new Set(requests.map(r=>r.agent))],[`piagent/${version}`]);
    assert.equal(git(['rev-parse','HEAD']),head); assert.equal(git(['diff','--cached','--name-only']),'');
    gates.main.release.resolve(); await prompt;
    const receipts=managed.session.sessionManager.getEntries().filter(e=>e.type==='custom_message'&&e.customType==='agent-watch-helper-receipt');
    assert.equal(receipts.length,2);
    assert.match(JSON.stringify(receipts), /15 tokens/);
    if (!changeDuringReview) assert.match(JSON.stringify(managed.session.messages), /code changed after review/);
    assert.equal(calls.filter(c=>c.action==='child').length,2);
    assert.deepEqual(calls.filter(c=>c.action==='close'&&c.role).map(c=>c.role).sort(),['research','review']);
  } finally {
    Object.values(gates).forEach(g=>g.release.resolve());
    await prompt?.catch(()=>{}); await managed?.dispose();
    await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true});
  }
});

// Scout and verify: each runs with its own tools, only when the Harness
// enables it. Verify runs the repository's checks with the project read-only,
// and a check that passed there counts for the run.
test('scout and verify helpers run with their own tools and only when the Harness enables them', {skip: !supported, timeout: 120000}, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-scout-verify-')));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = args => execFileSync('/usr/bin/git', args, {cwd:project, encoding:'utf8'}).trim();
  git(['init', '-q']);
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Fixture\n\n## Checks\n- `sh check.sh`\n');
  // The check tries to write into the project: the verify sandbox refuses it.
  fs.writeFileSync(path.join(project, 'check.sh'), 'if (echo x > written.txt) 2>/dev/null; then echo PROJECT-WRITABLE; else echo PROJECT-READ-ONLY; fi\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline']);
  const roles = ['main', 'scout', 'verify'], roleIDs = Object.fromEntries(roles.map(role => [role, randomUUID()]));
  const runID = randomUUID(), authority = {studio_instance_id:randomUUID(), dataset_epoch:randomUUID(), auth_generation:1};
  const models = [{id:'main-model', provider_model_id:'gpt-6-sol', owned_by:'codex'}, {id:'helper-model', provider_model_id:'claude-opus-5-5', owned_by:'claude'}];
  const fences = {}, calls = [], requests = [], mainEntered = deferred(), mainRelease = deferred();
  let verifyStarts = 0;
  const invoke = ManagedToolBoundary.prototype.invoke;
  t.mock.method(ManagedToolBoundary.prototype, 'invoke', function(name, args, ...rest) {
    // countedCheck has captured the pre-check digest when it dispatches here.
    // Edit at that boundary, then execute the real sandbox command. A timer
    // from the provider response could fire before that digest on a busy host,
    // in which case accepting the check was correct and the assertion flaky.
    if (name === 'bash' && args.command === 'sh check.sh' && verifyStarts === 2)
      fs.writeFileSync(path.join(project, 'edited.txt'), 'main agent edit\n');
    return invoke.call(this, name, args, ...rest);
  });
  const grant = role => ({...authority, run_id:runID, role_id:roleIDs[role], role, fence:fences[role]=(fences[role]??0)+1,
    token:`as_run_${roleIDs[role]}_${'x'.repeat(43)}`, model_id:role==='main'?'main-model':'helper-model', provider:role==='main'?'codex':'claude', provider_model_id:role==='main'?'gpt-6-sol':'claude-opus-5-5', effort:'medium'});
  const broker = {async request(action, args={}) {
    calls.push({action, ...args});
    if(action==='config') return {schema_version:2, credential_mode:'managed', authority, models, harness:{configuration:{main:{model_ids:['main-model']}, scout:{model_ids:['helper-model']}, verify:{model_ids:['helper-model']}}}};
    if(['start','renew','child'].includes(action)) return grant(args.role??'main');
    if(action==='close') return true;
    throw Error('unexpected-broker-action');
  }, async dispose() {}};
  const server = http.createServer(async(req,res) => {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const role=Object.keys(roleIDs).find(role=>roleIDs[role]===req.headers['x-session-id']);
    requests.push({role,body});
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const emit = event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if(role==='main') {
      mainEntered.resolve(); await mainRelease.promise;
      const response={id:'resp_fixture',object:'response',status:'in_progress',model:body.model,output:[]};
      emit({type:'response.created',response});
      emit({type:'response.completed',response:{...response,status:'completed',usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});
      return res.end();
    }
    emit({type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:12,output_tokens:0}}});
    // Verify first runs the repository check, then answers with its verdicts.
    if(role==='verify' && !body.messages.some(m=>JSON.stringify(m).includes('tool_result'))) {
      verifyStarts += 1;
      emit({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_check',name:'bash',input:{}}});
      emit({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:'sh check.sh'})}});
      emit({type:'content_block_stop',index:0});
      emit({type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:3}});
    } else {
      const text = role==='verify' ? 'Checked.\n```json\n{"verdicts":[{"claim":"check passes","status":"pass","evidence":"sh check.sh"},{"claim":"docs","status":"unverifiable","evidence":"offline"}],"summary":"ok"}\n```' : 'Scout fixture result';
      emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
      emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text}});
      emit({type:'content_block_stop',index:0});
      emit({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}});
    }
    emit({type:'message_stop'}); res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let managed, prompt;
  try {
    managed=await ManagedSession.create({sdkRoot,cwd:project,origin:`http://127.0.0.1:${server.address().port}`,broker});
    managed.session.setThinkingLevel('medium');
    prompt=managed.session.prompt('Scout and verify this project');
    await mainEntered.promise;
    // The main agent is offered exactly the helpers the Harness enables.
    const delegate=(requests.find(r=>r.role==='main').body.tools??[]).find(t=>t.name==='delegate');
    assert.deepEqual(delegate.parameters.properties.role.enum,['scout','verify']);
    assert.match(delegate.description,/scout:.*no web/); assert.doesNotMatch(delegate.description,/review:/);
    // No research helper: the main agent searches the web itself, and reads up to 100,000 characters of a page.
    assert.ok(requests.find(r=>r.role==='main').body.tools.some(t=>t.name==='web_search'));
    assert.equal(requests.find(r=>r.role==='main').body.tools.find(t=>t.name==='web_fetch').parameters.properties.maxChars.maximum,100000);
    assert.match(JSON.stringify(requests.find(r=>r.role==='main').body),/You are Piagent, the company coding assistant/);
    assert.match(JSON.stringify(requests.find(r=>r.role==='main').body),/delegate role \\"scout\\"/);
    await assert.rejects(managed.delegate({role:'research',task:'Look this up'}), /managed-helper-not-configured: the company Harness has no research subagent; use scout, verify/);
    await assert.rejects(managed.delegate({role:'planner',task:'Plan'}), /managed-helper-unavailable/);
    const scouted=await managed.delegate({role:'scout',task:'Where is the check declared?'});
    assert.equal(content(scouted),'Scout fixture result');
    const executableTools = body => (body.tools??[]).filter(t=>t.name!=='__pi_deferred_placeholder__').map(t=>t.name).sort();
    // Scout reads the project only: no commands, no web.
    assert.deepEqual(executableTools(requests.find(r=>r.role==='scout').body),['find','grep','ls','read']);
    const verified=await managed.delegate({role:'verify',task:'Confirm the repository check passes'});
    const verifyRequests=requests.filter(r=>r.role==='verify');
    // Verify also runs commands and reads the web; it never writes or edits.
    assert.deepEqual(executableTools(verifyRequests[0].body),['bash','find','grep','ls','read','web_fetch','web_search']);
    // It is told the repository's checks.
    assert.match(JSON.stringify(verifyRequests[0].body.messages),/Repository checks: `sh check.sh`/);
    assert.match(JSON.stringify(verifyRequests.at(-1).body.messages),/PROJECT-READ-ONLY/);
    assert.equal(fs.existsSync(path.join(project,'written.txt')),false);
    assert.deepEqual(verified.details.verdicts,{pass:1,fail:0,unverifiable:1});
    // Its passing check counts for the run, like one the main agent ran.
    assert.equal(managed.run.checksRun,1); assert.equal(managed.run.lastCheck.ok,true);
    // A check during which the code changed proves nothing about either version.
    const lastCheck=managed.run.lastCheck;
    await managed.delegate({role:'verify',task:'Confirm it again'});
    assert.equal(fs.existsSync(path.join(project,'edited.txt')),true);
    assert.equal(managed.run.checksRun,1); assert.equal(managed.run.lastCheck,lastCheck);
    assert.equal(managed.session.sessionManager.getEntries().filter(e=>e.customType==='agent-watch-helpers').at(-1).data.maximum,2);
    mainRelease.resolve(); await prompt;
    const receipts=managed.session.sessionManager.getEntries().filter(e=>e.type==='custom_message'&&e.customType==='agent-watch-helper-receipt').map(e=>e.content);
    assert.equal(receipts.length,3);
    assert.match(receipts[0],/^Scout: \d+ tokens\.$/); assert.match(receipts[1],/^Verify: \d+ tokens · 1 pass, 1 unverifiable\.$/);
    assert.deepEqual(calls.filter(c=>c.action==='child').map(c=>c.role),['scout','verify','verify']);
    assert.deepEqual(calls.filter(c=>c.action==='close'&&c.role).map(c=>c.role),['scout','verify','verify']);
  } finally {
    mainRelease.resolve();
    await prompt?.catch(()=>{}); await managed?.dispose();
    await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true});
  }
});
