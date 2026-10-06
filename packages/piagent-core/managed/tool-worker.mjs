import { sandboxDiagnostic } from './sandbox-diagnostic.mjs';
import { fallbackFind, fallbackGrep } from './search-fallback.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
// A dedicated, credential-free process already inside Seatbelt. The launch
// profile and environment are supplied by the trusted runtime, never the LLM.
const [sdkPath, cwd] = process.argv.slice(2);
const api = await import(pathToFileURL(sdkPath).href);
const factories = { read: api.createReadToolDefinition, write: api.createWriteToolDefinition,
  edit: api.createEditToolDefinition, bash: api.createBashToolDefinition,
  grep: api.createGrepToolDefinition, find: api.createFindToolDefinition, ls: api.createLsToolDefinition };
let active = false, controller, network = false, isolated = false;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', async line => {
  try {
    const message = JSON.parse(line);
    if (message.cancel === true) { controller?.abort(); return; }
    if (active || !Object.hasOwn(factories, message.name)) throw new Error('managed-worker-request-invalid');
    active = true; controller = new AbortController(); network = message.network === true; isolated = message.isolated === true;
    const options = message.name === 'bash' ? { shellPath: '/bin/bash', exposeSessionEnvironment: false } : undefined;
    // The runtime copies ripgrep/fd here when the machine has or can fetch them.
    const provided = name => fs.existsSync(path.join(process.env.HOME ?? '', '.pi/agent/bin', name));
    const result = message.name === 'grep' && !provided('rg') ? fallbackGrep(cwd, message.args)
      : message.name === 'find' && !provided('fd') ? fallbackFind(cwd, message.args)
      : await factories[message.name](cwd, options).execute('managed-tool', message.args, controller.signal,
        update => emit({ update }), { cwd, model: message.model });
    // Successful output is returned verbatim; the sandbox note is only added to
    // failures (Pi tools throw on denial and on a non-zero shell exit).
    emit({ result });
  } catch (error) { emit({ error: sandboxDiagnostic(error instanceof Error ? error.message : 'managed-worker-failed', { network, isolated }) }); }
  finally { if (active) { input.close(); process.stdin.destroy(); } }
});
process.stdin.on('end', () => controller?.abort());
