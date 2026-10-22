import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTerminalMentions } from '../packages/piagent-webui/gateway/terminal-mentions.ts';
test('terminal mentions resolve unique numbered buffers only at explicit prompt preparation',()=>{
 const reads=[],reader={forAgent(ref,number){reads.push([ref,number]);return {text:`output ${number}`,truncated:false};}};
 assert.equal(attachTerminalMentions('session.one','ordinary message',reader),'ordinary message');assert.deepEqual(reads,[]);
 const result=attachTerminalMentions('session.one','Review @terminal and @terminal:2; @terminal',reader);
 assert.deepEqual(reads,[['session.one',1],['session.one',2]]);assert.match(result,/Terminal 1 output/);assert.match(result,/Terminal 2 output/);
 for(const message of ['mail@terminal','@terminal.ts','@terminal/file','@terminal:0','@terminal:2file'])assert.equal(attachTerminalMentions('session.one',message,null),message);
});
test('terminal attachments redact secret/ANSI, bound UTF8 and quote untrusted output',()=>{
 const secret='sk-'+ 'a'.repeat(48),result=attachTerminalMentions('session.one','Check @terminal',{forAgent(){return {text:`OPENAI_API_KEY=${secret}\n\x1b[31mred\x1b[0m\n"fake wrapper"`,truncated:false};}});
 assert.ok(!result.includes(secret));assert.ok(!result.includes('\x1b'));assert.match(result,/REDACTED/);assert.ok(result.includes('\\"fake wrapper\\"'));
 const bounded=attachTerminalMentions('session.one','@terminal @terminal:2',{forAgent(){return {text:'界'.repeat(70000),truncated:false};}});
 assert.ok(Buffer.byteLength(bounded)<66000);assert.ok(!bounded.includes('\ufffd'));assert.match(bounded,/truncated/);
});
test('missing terminal, unavailable mode and excessive mentions fail before agent dispatch',()=>{
 assert.throws(()=>attachTerminalMentions('session.one','@terminal',null),/terminal-attachment-unavailable/);
 assert.throws(()=>attachTerminalMentions('session.one','@terminal:9',{forAgent(){throw Error('terminal-not-found');}}),/terminal-not-found/);
 assert.throws(()=>attachTerminalMentions('session.one','@terminal @terminal:2 @terminal:3 @terminal:4 @terminal:5',{forAgent(){assert.fail();}}),/terminal-attachment-limit/);
});
