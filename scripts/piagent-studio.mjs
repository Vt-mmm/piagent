#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManagedBrokerClient } from '../packages/piagent-core/managed/broker-client.mjs';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { agentWatchDataDirectory, interopEnvironment, resolveStore, storedSlot } from '../packages/piagent-core/managed/store.mjs';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Node's experimental-feature notices (type stripping, SQLite) are not
// actionable for members and bury the launch messages in Terminal.
process.removeAllListeners('warning');
process.on('warning', warning => { if (warning.name !== 'ExperimentalWarning') process.stderr.write(`${warning.name}: ${warning.message}\n`); });
const args = process.argv.slice(2), flags = new Map();
if (args.includes('--help')) { console.log('piagent studio [--web [--no-open] | --serve | --check | --doctor | --prompt <text>] [--config <Agent Watch configuration>] [--project <folder>]\nDefaults: the configuration imported into ~/.pi/agent and the current project. Personal sessions remain under pi / piagent dashboard.'); process.exit(0); }
for (let i = 0; i < args.length; i++) {
  if (['--check', '--doctor', '--web', '--serve', '--no-open'].includes(args[i])) { flags.set(args[i], true); continue; }
  if (!['--config', '--project', '--prompt'].includes(args[i]) || flags.has(args[i]) || !args[i + 1]) throw Error('managed-launch-arguments');
  flags.set(args[i], args[++i]);
}
const home = os.homedir();
// Do this before importing the SDK: it must not discover personal keys, Node
// preload hooks, proxy overrides or provider endpoints from an ambient shell.
const clean = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', TERM: process.env.TERM || 'xterm-256color', ...interopEnvironment() };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, clean);
let broker, current, gateway, hold;
try {
  const configPath = fs.realpathSync(flags.get('--config') ?? path.join(home,'.pi/agent/agent-watch-managed.json'));
  if (!fs.statSync(configPath).isFile() || fs.statSync(configPath).size > 16384) throw Error('managed-config-invalid');
  const config = JSON.parse(fs.readFileSync(configPath));
  // Agent Watch rewrites this when the key or its harness changes.
  const bindingRevision = () => { try { return String(JSON.parse(fs.readFileSync(configPath, 'utf8')).configuration_revision ?? '') || null; } catch { return null; } };
  // --serve backs the personal dashboard: no browser, no project of its own.
  // Its startup probe runs in an empty private folder that is never listed.
  const serve = flags.has('--serve');
  if (serve && (flags.has('--project') || flags.has('--web') || flags.has('--check') || flags.has('--prompt'))) throw Error('managed-launch-arguments');
  if (config.schema_version !== 1 || config.model !== 'agent-watch-auto' || !/^[a-f0-9]{64}$/.test(config.profile_id)
    || config.entrypoint !== fs.realpathSync(fileURLToPath(import.meta.url)) || config.node !== fs.realpathSync(process.execPath)
    || digest(config.entrypoint) !== config.entrypoint_sha256 || digest(config.node) !== config.node_sha256
    || digest(config.broker) !== config.broker_sha256) throw Error('managed-launch-binding-changed');
  // What company sessions need on this machine, checked with the real sandbox
  // and broker; no conversation, no model request.
  if (flags.has('--doctor')) {
    const { runDoctor, doctorReport } = await import('../packages/piagent-core/managed/doctor.mjs');
    const asked = new ManagedBrokerClient({ executable: config.broker, profileID: config.profile_id });
    let report;
    try { report = doctorReport(await runDoctor({ sdkRoot: config.sdk_root, origin: config.origin, broker: asked })); }
    finally { await asked.dispose(); }
    console.log(report.text); process.exit(report.ok ? 0 : 1);
  }
  // Conversations live in one store per member on this machine, whichever key
  // Agent Watch holds: a key's slot learns its member once, then points there.
  const root = path.join(agentWatchDataDirectory(home), 'ManagedSessions');
  let store = storedSlot(root, config.profile_id);
  if (!store) {
    const asked = new ManagedBrokerClient({ executable: config.broker, profileID: config.profile_id });
    try { store = resolveStore(root, config.profile_id, { origin: config.origin, userId: (await asked.request('config'))?.user?.id }); }
    finally { await asked.dispose(); }
  }
  const agentDir = path.join(root, store);
  const cwd = serve ? path.join(agentDir, 'probe') : fs.realpathSync(flags.get('--project') || process.cwd());
  if (configPath.startsWith(cwd + path.sep)) throw Error('managed-launch-binding-changed');
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 }); fs.chmodSync(agentDir, 0o700);
  if (serve) { fs.mkdirSync(cwd, { recursive: true, mode: 0o700 }); fs.chmodSync(cwd, 0o700); }
  await import('./register-typescript-loader.mjs');
  if (flags.has('--web') || serve) {
    if (flags.has('--check') || flags.has('--prompt')) throw Error('managed-launch-arguments');
    const packageRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const {requestGatewayControl}=await import('../packages/piagent-webui/gateway/control-socket.ts');
    const {gatewayProfileState}=await import('../packages/piagent-webui/ownership/profile-state.ts');
    const control=gatewayProfileState(agentDir).controlSocket;
    const release=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
    const health=async()=>{ try { const reply=await requestGatewayControl(control,{action:'health'}); return reply.ok ? reply.value ?? {} : null; } catch { return null; } };
    // This key's company Gateway may already run: the dashboard starts one and
    // an earlier WebUI launch may still be open. Reuse it when it is this
    // release (a new browser session on this project); replace an older one.
    let running=await health();
    for(const started=Date.now();running && !running.packageVersion && running.state==='starting' && Date.now()-started<45000;running=await health()) await new Promise(r=>setTimeout(r,250));
    if(running && running.packageVersion!==release){
      try { await requestGatewayControl(control,{action:'stop'}); } catch {}
      for(const started=Date.now();await health();) { if(Date.now()-started>15000) throw Error('managed-launch-stale-runtime'); await new Promise(r=>setTimeout(r,250)); }
      running=null;
    }
    if(!running){
      const {startManagedGateway}=await import('../packages/piagent-webui/gateway/managed-gateway.mjs');
      gateway=await startManagedGateway({config,configPath,cwd,agentDir,registerProject:!serve,packageRoot});
    }
    if (serve) process.stdout.write('Agent Watch Auto: ready\n');
    else {
      // Register (idempotent) to learn the project's ref: the page opens a new
      // conversation for the project chosen in Agent Watch.
      const registered=await requestGatewayControl(control,{action:'project.register',cwd});
      if(!registered.ok || typeof registered.value?.projectRef!=='string') throw Error('managed-web-launch-failed');
      const result=await requestGatewayControl(control,{action:'issue-launch-url'});
      if(!result.ok || !result.value?.launchUrl) throw Error('managed-web-launch-failed');
      result.value.launchUrl+=`&project=${encodeURIComponent(registered.value.projectRef)}`;
      process.stdout.write(`Agent Watch Auto: ${result.value.launchUrl}\n`);
      if(!flags.has('--no-open')){ const {spawn}=await import('node:child_process'); spawn('/usr/bin/open',[result.value.launchUrl],{stdio:'ignore',env:clean}).unref(); }
    }
    if(gateway){
      process.once('SIGINT',()=>void gateway.close());process.once('SIGTERM',()=>void gateway.close());
      await gateway.wait();
    } else if(!serve) process.stdout.write('Agent Watch Auto: opened in the running company session service; closing this window does not stop it.\n');
  } else {
  // The key Agent Watch holds now: a conversation that enrolls again follows it.
  const slot = () => { try { const now = JSON.parse(fs.readFileSync(configPath, 'utf8')); return /^[a-f0-9]{64}$/.test(now.profile_id) && now.broker === config.broker ? now.profile_id : config.profile_id; } catch { return config.profile_id; } };
  const newBroker = () => new ManagedBrokerClient({ executable: config.broker, profileID: slot() });
  broker = newBroker();
  const api = await import(pathToFileURL(path.join(config.sdk_root, 'dist/index.js')));
  // The conversation this process writes is held in the same lease the
  // company Gateway uses: the WebUI shows it running here and never runs it
  // at the same time. One the WebUI is running is refused.
  const { holdManagedSession } = await import('../packages/piagent-webui/ownership/managed-terminal-lease.ts');
  const factory = async ({ cwd, sessionManager }) => {
    let next;
    try { next = holdManagedSession(agentDir, sessionManager.getSessionFile()); }
    catch (error) { throw Error(String(error?.message) === 'session-owner-conflict' ? 'managed-session-open-elsewhere' : 'managed-session-lease-unavailable'); }
    hold?.release(); hold = next;
    // A conversation that enrolled again (key or harness changed) holds the live broker.
    if (current) { broker = current.broker; await current.session.abort(); await Promise.allSettled([...current.helpers.values()]); await broker.request('close'); current.session.dispose(); await current.boundary.dispose(); }
    current = await ManagedSession.create({ sdkRoot: config.sdk_root, cwd, origin: config.origin, broker, agentDir, sessionManager,
      protectedRoots: [configPath, agentDir], renewBroker: newBroker, bindingRevision });
    return { session: current.session, extensionsResult: current.extensionsResult, services: current.services, diagnostics: [] };
  };
  const host = await api.createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: api.SessionManager.create(cwd, path.join(agentDir, 'sessions')) });
  if (flags.get('--check')) console.log('agent-watch-auto: connected; native context; isolated tools; no inference sent.');
  else if (flags.has('--prompt')) {
    current.session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
      if (event.type === 'message_end' && ['agent-watch-helper-receipt','agent-watch-review-status'].includes(event.message?.customType)) process.stderr.write(String(event.message.content) + '\n');
    });
    await current.session.prompt(flags.get('--prompt')); process.stdout.write('\n');
    const last=current.session.messages.filter(message=>message.role==='assistant').at(-1);
    if (last?.stopReason === 'error') {
      // Already says who failed and why, ending in its stable [code].
      process.stderr.write(`${String(last.errorMessage??'Agent Watch: the request failed [managed-request-failed]')}\n`);process.exitCode = 1;
    }
  } else {
    // The company terminal runs the pinned Pi release: no "Run pi update" notice
    // (updating Pi breaks the Agent Watch import), no package-update, catalog or
    // install-telemetry calls. Search tools were provisioned above.
    process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
    await new api.InteractiveMode(host, { verbose: false }).run();
  }
  }
} catch (error) {
  // Never print JSON payloads or startup objects that can contain role tokens.
  const code = error instanceof Error && /^managed-[a-z:_-]+$/.test(error.message) ? error.message : 'managed-launch-failed';
  const hint = code === 'managed-session-open-elsewhere' ? 'This conversation is running in the Piagent WebUI; continue it there, or start a new one here.'
    : process.platform === 'linux' ? 'In Agent Watch for Windows, choose Connect Piagent in WSL again.' : 'Refresh the Studio import or check Keychain access.';
  process.stderr.write(`Agent Watch: ${code}. ${hint}\n`); process.exitCode = 1;
} finally { await gateway?.close(); if (current) await current.dispose(); else await broker?.dispose(); hold?.release(); }
