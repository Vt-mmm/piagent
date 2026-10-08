// A company conversation's access, chosen by the member and kept with the
// conversation: "workspace-write" asks before every command that needs the
// internet; "trusted-full-access" (Bypass) asks only for what must be
// confirmed (runtime/policy/bypass-policy.mjs).
import { mustConfirm } from '../runtime/policy/bypass-policy.mjs';

export const PERMISSIONS = ['workspace-write', 'trusted-full-access'];
const ENTRY = 'agent-watch-permission';

export function restorePermission(manager) {
  const chosen = manager.getEntries().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data?.mode;
  return PERMISSIONS.includes(chosen) ? chosen : 'workspace-write';
}
export function permissionSetter(owner, manager) {
  return mode => {
    if (!PERMISSIONS.includes(mode)) throw Error('managed-permission-unavailable');
    manager.appendCustomEntry(ENTRY, { mode, at: new Date().toISOString() }); owner.permission = mode;
  };
}
// Why a network command must still be asked about: null runs it in Bypass,
// 'ask' when the member asks first.
export const networkConfirmation = (owner, command) => owner.permission === 'trusted-full-access' ? mustConfirm(command) : 'ask';

// run_with_network: one command with the internet (or a local server), after
// the member approves that exact command; Bypass runs it unless it must ask.
export function networkTool(self) {
  return {name:'run_with_network',label:'Run with network',description:'Run one shell command that needs the internet (package install, download, git pull of a public repository), or that starts a local server or a browser (end-to-end tests with Playwright\'s Chromium against a server on 127.0.0.1), after the user approves that exact command. Normal bash has no network and cannot listen on a port. Credentials (.npmrc, SSH keys, Keychain) stay unavailable, so private registries and git push are not possible here.',
    parameters:{type:'object',properties:{command:{type:'string',minLength:1,maxLength:4000},reason:{type:'string',minLength:1,maxLength:300},timeout:{type:'number',minimum:1,maximum:1800}},required:['command','reason'],additionalProperties:false},
    execute:async(id,args,signal,onUpdate,ctx)=>{
      // Bypass runs it without asking, unless it is one the member must confirm.
      const confirm=await networkConfirmation(self,args.command);
      const decision=confirm===null?{allowed:true,consume:()=>true}:await (await import('../runtime/inspection/approval-broker.ts')).piApprovalBroker.request({cwd:self.cwd,rawSessionId:self.session.sessionManager.getSessionId(),toolCallId:id,
        action:{kind:'external-provider-action',preconditionClass:'runtime-only',toolName:'run_with_network',rawAction:{command:args.command},commandPreview:String(args.command),
          targetPaths:[self.cwd],provider:'network',urlOrigin:null,requestedScope:'network-command-once',reason:(confirm==='ask'?String(args.reason):`Bypass still asks: ${confirm}. ${args.reason}`).slice(0,300),riskClass:'medium',
          allowConsequence:'Run this exact command once, with internet access; a server it starts accepts connections while it runs.',denyConsequence:'The command does not run; the agent is told you declined.'},
        terminalConfirm:()=>ctx?.ui?.confirm?.('Chạy lệnh có internet',`${args.command}\n\nLý do: ${args.reason}${confirm==='ask'?'':`\nBypass vẫn hỏi: ${confirm}`}\n\nĐồng ý: chạy đúng lệnh này một lần, có internet; server nó mở nhận kết nối trong lúc chạy.\nTừ chối: lệnh không chạy, agent được báo bạn đã từ chối.`)??Promise.resolve(false),
        unavailableFallback:'terminal-confirm',recheck:()=>!signal?.aborted&&Boolean(self.grant)});
      if(!decision.allowed||!decision.consume()||signal?.aborted)throw Error('managed-operation-denied');
      let ok=false;
      const before=await self.changedFiles();
      try { const result=await self.boundary.invoke('bash',{command:args.command,...(args.timeout?{timeout:args.timeout}:{})},signal,onUpdate,ctx?.model,{network:true}); ok=!result?.isError; return result; }
      finally { await self.claimChanges(before); await self.run?.afterTool('bash',args,ok,()=>self.digest()); await self.refreshReview(); }
    }};
}
