import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {ManagedToolBoundary} from '../packages/piagent-core/managed/tool-boundary.mjs';
import {repositoryFetchPlan,repositoryFolder,executeRepositoryFetch,githubRemote} from '../packages/piagent-core/managed/repository-operation.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';
const sdkRoot = piSdkRoot();
test('repository operation accepts only a credential-free GitHub origin',()=>{
  assert.deepEqual(githubRemote('git@github.com:owner/repo.git'),{repository:'owner/repo',url:'https://github.com/owner/repo.git'});
  assert.equal(githubRemote('https://github.com/owner/repo').repository,'owner/repo');
  for(const value of ['ext::sh command','file:///secret','https://token@github.com/a/b','https://github.com.evil/a/b','git@evil:a/b','https://github.com/a/b?token=x','https://github.com/a/../secret','https://github.com/a/b\nsecret']) assert.throws(()=>githubRemote(value));
});
test('approved fetch imports only branches in sandbox and rejects changed origin before credentials', {skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:120000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-fetch-test-'))),project=path.join(root,'project'),source=path.join(root,'source');
 fs.mkdirSync(project);fs.mkdirSync(source);
 const git=(cwd,args)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8'}).trim();
 git(source,['init','-qb','main']);fs.writeFileSync(path.join(source,'sample'),'upstream\n');git(source,['add','.']);git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','source']);
 git(project,['init','-qb','main']);fs.writeFileSync(path.join(project,'local'),'unchanged\n');git(project,['add','.']);git(project,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','local']);
 git(project,['remote','add','origin','git@github.com:fixture/repo.git']);
 const head=git(project,['rev-parse','HEAD']);
 const boundary=new ManagedToolBoundary({cwd:project,sdkRoot,protectedRoots:[source]});let transports=0;
 try {
  const plan=await repositoryFetchPlan(boundary);
  const transport=async(_plan,destination)=>{transports++;git(root,['clone','--bare','--quiet',source,destination]);};
  const result=await executeRepositoryFetch(boundary,plan,undefined,{transport});
  assert.equal(result.details.repository,'fixture/repo');assert.equal(transports,1);
  assert.equal(git(project,['rev-parse','refs/remotes/origin/main']),git(source,['rev-parse','HEAD']));
  assert.equal(git(project,['rev-parse','HEAD']),head);assert.equal(fs.readFileSync(path.join(project,'local'),'utf8'),'unchanged\n');
  git(project,['remote','set-url','origin','https://github.com/other/repo']);
  await assert.rejects(executeRepositoryFetch(boundary,plan,undefined,{transport}),/scope-changed/);
  assert.equal(transports,1);
 } finally {await boundary.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('fetch origin of a repository inside a workspace folder', {skip:process.platform!=='darwin'||!fs.existsSync(sdkRoot),timeout:120000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'managed-fetch-workspace-'))),workspace=path.join(root,'workspace'),project=path.join(workspace,'api'),source=path.join(root,'source');
 fs.mkdirSync(project,{recursive:true});fs.mkdirSync(source);
 const git=(cwd,args)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8'}).trim();
 git(source,['init','-qb','dev']);fs.writeFileSync(path.join(source,'sample'),'upstream\n');git(source,['add','.']);git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','source']);
 git(project,['init','-qb','dev']);git(project,['remote','add','origin','https://github.com/fixture/api.git']);
 const boundary=new ManagedToolBoundary({cwd:workspace,sdkRoot,protectedRoots:[source]});
 try {
  // The workspace folder itself is no repository: the error names path.
  await assert.rejects(repositoryFetchPlan(boundary),/not a Git repository\. Pass path/);
  for(const folder of ['../source','/etc','missing']) assert.throws(()=>repositoryFolder(workspace,folder),/managed-repository-(path-invalid|not-found)/);
  const plan=await repositoryFetchPlan(boundary,'api');
  assert.deepEqual({...plan},{repository:'fixture/api',url:'https://github.com/fixture/api.git',cwd:project});
  const transport=async(_plan,destination)=>{git(root,['clone','--bare','--quiet',source,destination]);};
  await executeRepositoryFetch(boundary,plan,undefined,{transport});
  assert.equal(git(project,['rev-parse','refs/remotes/origin/dev']),git(source,['rev-parse','HEAD']));
 } finally {await boundary.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
