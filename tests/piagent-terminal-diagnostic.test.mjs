import test from 'node:test';
import assert from 'node:assert/strict';
import { personalTerminalDiagnostic } from '../packages/piagent-webui/gateway/personal-terminal-diagnostic.mjs';
test('terminal doctor reports optional module load separately from shell qualification',()=>{
 const available=personalTerminalDiagnostic(()=>({spawn(){assert.fail('doctor must not open shell');}}),'darwin');
 assert.equal(available.available,true);assert.equal(available.shellSpawnVerified,false);
 assert.equal(personalTerminalDiagnostic(()=>{throw Error('missing');},'linux').reasonCode,'terminal-native-module-unavailable');
 assert.equal(personalTerminalDiagnostic(()=>({}),'linux').available,false);
 assert.equal(personalTerminalDiagnostic(()=>{assert.fail();},'win32').reasonCode,'terminal-platform-unavailable');
});
