import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {managedGit} from './toolchain.mjs';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const text = result => result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n').trim();
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function githubRemote(value) {
  // No arbitrary protocol helper, userinfo, port, query, refspec or SSH command.
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/.exec(value);
  if (!match || match.slice(1).some(x=>x==='.'||x==='..')) throw Error('managed-repository-origin-unsupported');
  return {repository:`${match[1]}/${match[2]}`,url:`https://github.com/${match[1]}/${match[2]}.git`};
}

export async function repositoryFetchPlan(boundary) {
  const result=await boundary.invoke('bash',{command:'git config --local --get remote.origin.url',timeout:5});
  const remote=githubRemote(text(result));
  return Object.freeze({...remote,cwd:boundary.cwd});
}

function command(binary,args,{cwd,env,signal,secret='',limit=1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(Error('managed-operation-cancelled'));
    const child=spawn(binary,args,{cwd,env,stdio:['ignore','pipe','pipe']});let output='',size=0,failed=false;
    const abort=()=>{failed=true;child.kill('SIGKILL')};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,60000);timer.unref();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>limit)abort();else output+=chunk});
    // Credential helpers and Git diagnostics are never relayed to model context.
    child.stderr.on('data',()=>{});child.on('error',()=>{failed=true});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(failed||code!==0) reject(Error(signal?.aborted?'managed-operation-cancelled':'managed-repository-fetch-failed'));
      else resolve(secret?output.replaceAll(secret,'[REDACTED]'):output);
    });
  });
}

export async function fetchRepositoryBundle(plan, destination, signal) {
  // This private process sees only fixed arguments and an empty bare repo. It
  // never executes a command, hook, helper, filter or config from the project.
  const git=managedGit(), gitHash=hash(git);
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-fetch-')));
  fs.chmodSync(temporary,0o700);
  const env={PATH:'/usr/bin:/bin',HOME:temporary,LANG:'en_US.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'/usr/bin/false'};
  let token='';
  try {
    // gh reads the logged-in user's own GitHub credential, never a Studio key.
    // A public repository works without gh. Private access remains unavailable
    // until that user signs in; no personal credential is put in agent env.
    for(const candidate of ['/opt/homebrew/bin/gh','/usr/local/bin/gh']) {
      if(!fs.existsSync(candidate))continue;
      const gh=fs.realpathSync(candidate);
      try {token=(await command(gh,['auth','token','--hostname','github.com'],{cwd:temporary,env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),LANG:'en_US.UTF-8'},signal,limit:4096})).trim();} catch {}
      break;
    }
    if(token && !/^[A-Za-z0-9_]{10,2048}$/.test(token)) throw Error('managed-github-credential-invalid');
    await command(git,['init','--bare','--quiet',temporary],{cwd:temporary,env,signal});
    if(hash(git)!==gitHash)throw Error('managed-runtime-changed');
    const authentication=token?{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+Buffer.from('x-access-token:'+token).toString('base64')}:{};
    await command(git,['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','http.followRedirects=false','-c','protocol.allow=never','-c','protocol.https.allow=always','fetch','--quiet','--no-tags','--no-recurse-submodules','--depth=100',plan.url,'+refs/heads/*:refs/heads/*'],{cwd:temporary,env:{...env,...authentication},signal,secret:token});
    // A self-contained bundle cannot be shallow. Do not silently fetch an
    // unbounded history; export fetched objects as a local bare repository.
    fs.cpSync(temporary,destination,{recursive:true,errorOnExist:true,force:false});
    // Remote URL/config is not needed by the untrusted offline import.
    fs.writeFileSync(path.join(destination,'config'),'[core]\n\tbare = true\n');
  } finally {token='';fs.rmSync(temporary,{recursive:true,force:true});}
}

export async function executeRepositoryFetch(boundary,plan,signal,{transport=fetchRepositoryBundle}={}) {
  const current=await repositoryFetchPlan(boundary);
  if(current.url!==plan.url||current.cwd!==plan.cwd)throw Error('managed-operation-scope-changed');
  const staging=path.join(boundary.temporary,'approved-origin-'+Date.now());
  try {
    await transport(plan,staging,signal);
    const rechecked=await repositoryFetchPlan(boundary);
    if(rechecked.url!==plan.url)throw Error('managed-operation-scope-changed');
    // Import is sandboxed. Malicious repo hooks/config cannot reach credentials.
    await boundary.invoke('bash',{command:`git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always fetch --no-tags --no-recurse-submodules --no-write-fetch-head --update-shallow ${quote(staging)} '+refs/heads/*:refs/remotes/origin/*'`,timeout:30},signal);
    return {content:[{type:'text',text:`Fetched origin branches for ${plan.repository}. Working files and current branch were not changed.`}],details:{operation:'git.fetch',repository:plan.repository}};
  } finally {fs.rmSync(staging,{recursive:true,force:true});}
}

// The fetch_origin tool of a company conversation: one approved fetch of the
// GitHub origin (Bypass fetches without asking).
export function fetchOriginTool(self) {
  return {name:'fetch_origin',label:'Fetch origin',description:'Request one approved GitHub origin fetch. Refreshes origin branches without changing working files. Does not expose credentials or allow arbitrary network commands.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    execute:async(id,_args,signal,_update,ctx)=>{
      const plan=await repositoryFetchPlan(self.boundary);
      if(self.permission==='trusted-full-access'&&!signal?.aborted)return executeRepositoryFetch(self.boundary,plan,signal);
      const {piApprovalBroker}=await import('../runtime/inspection/approval-broker.ts');
      const decision=await piApprovalBroker.request({cwd:self.cwd,rawSessionId:self.session.sessionManager.getSessionId(),toolCallId:id,
        action:{kind:'external-provider-action',preconditionClass:'runtime-only',toolName:'fetch_origin',rawAction:plan,
          targetPaths:[self.cwd],provider:'github',urlOrigin:'https://github.com',requestedScope:'fetch-origin-once',
          reason:`Fetch origin branches from ${plan.repository}`,riskClass:'low',allowConsequence:'Download origin branches once; keep the current branch and working files unchanged.',denyConsequence:'No network request or credential read.'},
        terminalConfirm:()=>ctx?.ui?.confirm?.('Tải nhánh từ origin',`Tải các nhánh của ${plan.repository} về ${self.cwd} một lần.\n\nĐồng ý: chỉ tải nhánh; nhánh hiện tại và file đang làm không đổi.\nTừ chối: không gửi request mạng, không đọc thông tin đăng nhập.`)??Promise.resolve(false),
        unavailableFallback:'terminal-confirm',recheck:()=>!signal?.aborted&&Boolean(self.grant)});
      if(!decision.allowed||!decision.consume()||signal?.aborted)throw Error('managed-operation-denied');
      return executeRepositoryFetch(self.boundary,plan,signal);
    }};
}
