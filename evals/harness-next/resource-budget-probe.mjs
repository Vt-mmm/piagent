// Diagnostic only. The host sends this trusted probe to a constrained worker
// image; candidate source is evaluated exclusively inside its QuickJS realm.
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { createGuestSession } from "/executor/guest.mjs";
import { parseRequest, WORKER_VERSION } from "/executor/protocol.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16384) throw new Error("Probe input limit");
}
const { requestText, stallMs } = JSON.parse(input);
if (![0, 600, 5200].includes(stallMs)) throw new Error("Invalid probe stall");
const request = parseRequest(requestText);
if (request.cases.length !== 1) throw new Error("One diagnostic case required");
const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
let interrupts = 0, stalled = false;
const instrumented = { newRuntime() {
  const runtime = QuickJS.newRuntime(), install = runtime.setInterruptHandler.bind(runtime);
  runtime.setInterruptHandler = (handler) => install((...args) => {
    interrupts++;
    if (stallMs && !stalled) {
      stalled = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    }
    return handler(...args);
  });
  return runtime;
} };
const session = createGuestSession(instrumented, request, performance.now() + 5000);
const cpuStart = process.cpuUsage(), wallStart = performance.now();
let observation;
try { observation = session.execute(request.cases[0]); }
finally { session.dispose(); }
const cpu = process.cpuUsage(cpuStart);
process.stdout.write(JSON.stringify({ diagnostic: "resource-budget-probe-v1", workerVersion: WORKER_VERSION,
  stallMs, stalled, interrupts, elapsedMs: performance.now() - wallStart, cpuMicros: cpu.user + cpu.system, observation }));
