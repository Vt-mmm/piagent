import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {test} from 'node:test';
const sdkRoot=process.env.PI_MANAGED_TEST_SDK??path.join(os.homedir(),'.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
test('production CLI executes both delegated roles from a native tool response with a clean environment',{skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:120000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-delegation-cli-'))),project=path.join(root,'project');fs.mkdirSync(project);
 execFileSync('/usr/bin/git',['init','-q',project]);fs.writeFileSync(path.join(project,'README.md'),'before\n');execFileSync('/usr/bin/git',['-C',project,'add','.']);execFileSync('/usr/bin/git',['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','baseline']);fs.writeFileSync(path.join(project,'README.md'),'after\n');
 const roles=Object.fromEntries(['main','research','review'].map(r=>[r,randomUUID()])),requests=[];
 const authority={studio_instance_id:randomUUID(),dataset_epoch:randomUUID(),auth_generation:1},runID=randomUUID();
 const models=[{id:'claude-sonnet-5-5',provider_model_id:'claude-sonnet-5-5',owned_by:'claude',max_output_tokens:16384},{id:'gpt-6-luna',provider_model_id:'gpt-6-luna',owned_by:'codex',max_output_tokens:16384}];
 const manifest={schema_version:2,credential_mode:'managed',authority,key_id:randomUUID(),models,harness:{configuration:{main:{model_ids:[models[0].id]},research:{model_ids:[models[1].id]},review:{model_ids:[models[0].id]}}}};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks)),role=Object.keys(roles).find(r=>roles[r]===req.headers['x-session-id']);requests.push({role,body});
  res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=e=>res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if(role==='research'){
   const item={id:'msg_research',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'RESEARCH_OK',annotations:[]}]},response={id:'resp_research',object:'response',model:body.model,status:'in_progress',output:[]};
   emit({type:'response.created',response});emit({type:'response.output_item.added',output_index:0,item:{...item,content:[],status:'in_progress'}});emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'RESEARCH_OK'});emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:12,output_tokens:3,total_tokens:15}}});
  }else{
   emit({type:'message_start',message:{id:'msg_'+role,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:12,output_tokens:0}}});
   const delegate=role==='main'&&requests.filter(r=>r.role==='main').length===1;
   if(delegate){for(const [index,child]of ['research','review'].entries()){
    emit({type:'content_block_start',index,content_block:{type:'tool_use',id:'toolu_'+child,name:'delegate',input:{}}});emit({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify({role:child,task:'Reply briefly without tools'})}});emit({type:'content_block_stop',index});
   }}else{emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:role==='main'?'DELEGATION_OK':'REVIEW_OK'}});emit({type:'content_block_stop',index:0});}
   emit({type:'message_delta',delta:{stop_reason:delegate?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}});emit({type:'message_stop'});
  }res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profileID=createHash('sha256').update(root).digest('hex'),sessions=path.join(os.homedir(),'Library/Application Support/AgentWatch/ManagedSessions',profileID);
 try{
  assert.equal(fs.existsSync(sessions),false);const broker=path.join(root,'broker');
  fs.writeFileSync(broker,`#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},roles=${JSON.stringify(roles)},authority=${JSON.stringify(authority)};let fence=0;for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line),role=q.role??'main',m=manifest.models[role==='research'?1:0];process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...authority,run_id:'${runID}',role_id:roles[role],role,fence:++fence,token:'as_run_'+roles[role]+'_${'x'.repeat(43)}',provider:m.owned_by,model_id:m.id,provider_model_id:m.id,effort:q.effort??'medium'}})+'\\n');}`,{mode:0o700});
  const entry=fs.realpathSync(path.resolve('scripts/piagent-studio.mjs')),node=fs.realpathSync(process.execPath),hash=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify({schema_version:1,model:'agent-watch-auto',profile_id:profileID,origin:`http://127.0.0.1:${server.address().port}`,node,entrypoint:entry,node_sha256:hash(node),entrypoint_sha256:hash(entry),sdk_root:sdkRoot,broker,broker_sha256:hash(broker)}));
  const result=await new Promise((resolve,reject)=>{const p=spawn(node,[entry,'--config',file,'--project',project,'--prompt','Run both helpers'],{env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),TERM:'dumb'},stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>text+=b);p.on('error',reject);p.on('close',code=>resolve({code,text}));});
  assert.equal(result.code,0,result.text);assert.match(result.text,/DELEGATION_OK/);
  assert.deepEqual(requests.map(r=>r.role).sort(),['main','main','research','review'],JSON.stringify(requests.filter(r=>r.role==='main').at(-1)?.body.messages.at(-1)));
  const interactive=await new Promise((resolve,reject)=>{
   // macOS script requires its own stdin to be a tty. Python's pty opens an
   // actual controlling terminal and keeps this acceptance independent of CUA.
   const code = `import os,pty,select,signal,sys,time
pid,fd=pty.fork()
if pid==0:
 os.execve(sys.argv[1],sys.argv[1:],dict(PATH='/usr/bin:/bin',HOME=os.path.expanduser('~'),TERM='xterm-256color'))
text=b'';ready=False;until=time.monotonic()+10
try:
 while time.monotonic()<until:
  if select.select([fd],[],[],.1)[0]:
   try:data=os.read(fd,65536)
   except OSError:break
   if not data:break
   text+=data
   if not ready and b'agent-watch-auto' in text:
    ready=True;os.write(fd,b'\\x03');time.sleep(.15);os.write(fd,b'\\x03')
  done,status=os.waitpid(pid,os.WNOHANG)
  if done:break
 else:os.kill(pid,signal.SIGKILL)
finally:
 os.close(fd)
 try:os.waitpid(pid,0)
 except ChildProcessError:pass
print('INTERACTIVE_READY' if ready else text.decode('utf8','replace')[-2000:])
sys.exit(0 if ready else 1)`;
   const p=spawn('/usr/bin/python3',['-c',code,node,entry,'--config',file,'--project',project],{env:{PATH:'/usr/bin:/bin',HOME:os.homedir()},stdio:['ignore','pipe','pipe']});
   let text='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>text+=b);p.on('error',reject);p.on('close',code=>resolve({code,text}));
  });
  assert.equal(interactive.code,0,interactive.text);
  assert.match(interactive.text,/INTERACTIVE_READY/);
  assert.equal(requests.length,4,'opening and closing the interactive CLI must not infer');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});fs.rmSync(sessions,{recursive:true,force:true});}
});
