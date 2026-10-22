import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { writeWorkspaceFile } from '../packages/piagent-core/extensions/workspace-write.ts';
const sha = text => createHash('sha256').update(text).digest('hex');
const policy = { policy: { protectedPaths: ['secret/**'] }, profile: { readOnlyPaths: ['vendor/**'] } };
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-write-'));
 t.after(() => fs.rmSync(root, {recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'source.ts'),'before\n',{mode:0o750});
 fs.chmodSync(path.join(root,'source.ts'),0o750);
 for(const name of ['secret','vendor']) {fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'a'),'locked');}
 return root;
}
test('workspace save creates and atomically replaces files with the expected digest and mode', t => {
 const root=fixture(t);
 const result=writeWorkspaceFile(root,{path:'source.ts',content:'after\n',expectedDigest:sha('before\n')},policy);
 assert.equal(result.digest,sha('after\n'));assert.equal(result.created,false);
 assert.equal(fs.readFileSync(path.join(root,'source.ts'),'utf8'),'after\n');
 assert.equal(fs.statSync(path.join(root,'source.ts')).mode & 0o777,0o750);
 assert.equal(writeWorkspaceFile(root,{path:'new.ts',content:'new',expectedDigest:'absent'},policy).created,true);
 assert.equal(fs.statSync(path.join(root,'new.ts')).mode & 0o777,0o600);
 assert.equal(fs.readdirSync(root).some(x=>x.startsWith('.piagent-write-')),false);
});
test('workspace save refuses intervening edits and existing-file creation without touching content', t => {
 const root=fixture(t);
 fs.writeFileSync(path.join(root,'source.ts'),'agent edit');
 for(const expectedDigest of [sha('before\n'),'absent']) {
  assert.throws(()=>writeWorkspaceFile(root,{path:'source.ts',content:'member edit',expectedDigest},policy),e=>e.code==='stale-content' && e.currentDigest===sha('agent edit'));
 }
 assert.equal(fs.readFileSync(path.join(root,'source.ts'),'utf8'),'agent edit');
});
test('workspace save respects profile, protected paths, traversal and symbolic ancestors', t => {
 const root=fixture(t), outside=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-outside-'));
 t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
 fs.writeFileSync(path.join(outside,'a'),'outside');fs.symlinkSync(outside,path.join(root,'link'));
 fs.symlinkSync(path.join(outside,'a'),path.join(root,'link.ts'));
 for(const name of ['secret/a','SECRET/a','vendor/a','../escape','/outside','x/../source.ts','link/a','link.ts'])
  assert.throws(()=>writeWorkspaceFile(root,{path:name,content:'changed',expectedDigest:'absent'},policy),name);
 for(const context of [{...policy,readOnly:true},{...policy,profile:{permissionProfile:'read-only'}}])
  assert.throws(()=>writeWorkspaceFile(root,{path:'source.ts',content:'changed',expectedDigest:sha('before\n')},context),e=>e.code==='read-only');
 assert.equal(fs.readFileSync(path.join(outside,'a'),'utf8'),'outside');
 assert.equal(fs.readFileSync(path.join(root,'source.ts'),'utf8'),'before\n');
});
test('workspace save removes its temporary file after a failed rename', t => {
 const root=fixture(t), rename=fs.renameSync;
 fs.renameSync=()=>{throw new Error('injected-rename-failure');};
 try {assert.throws(()=>writeWorkspaceFile(root,{path:'source.ts',content:'after',expectedDigest:sha('before\n')},policy),/injected-rename-failure/);}
 finally {fs.renameSync=rename;}
 assert.equal(fs.readFileSync(path.join(root,'source.ts'),'utf8'),'before\n');
 assert.equal(fs.readdirSync(root).some(x=>x.startsWith('.piagent-write-')),false);
});
