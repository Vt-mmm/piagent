import { createHash } from "node:crypto";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, NODE_WORKER_VERSION, WORKER_VERSION, parseRequest } from "./protocol.mjs";
import { createGuestSession } from "./guest.mjs";
import { CPU_EXHAUSTED, WALL_EXHAUSTED, REQUEST_WALL_MS } from "./budget.mjs";
import { resolveArguments } from "./references.mjs";

// This executable belongs inside the constrained container, never the agent's
// process. stdout is the trusted runner's channel; QuickJS has no stdout binding.
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Request size exceeded");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const request = parseRequest(text);
  const requestDigest = createHash("sha256").update(text).digest("hex");
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const deadline = performance.now() + REQUEST_WALL_MS;
  const cases = [];
  let status = "completed";
  let timeoutReason;
  const observations = new Map();
  const typedOutputBudget = { rawBytes: 0 };
  const timerTrace = [];
  let quiescence = { pendingTimers: 0, liveDecoders: 0, receivers: 0 };
  let session, sequence;
  const disposeSession = () => {
    const summary = session?.dispose();
    for (const item of summary?.timerTrace ?? []) timerTrace.push({ ...item, sequence: timerTrace.length });
    if (summary?.quiescence) quiescence = summary.quiescence;
    session = undefined;
  };
  try {
    for (const item of request.cases) {
      if (performance.now() >= deadline) { status = "timeout"; timeoutReason = WALL_EXHAUSTED; break; }
      if (!session || !item.sequence || sequence !== item.sequence || item.reset) {
        disposeSession(); session = createGuestSession(QuickJS, request, deadline, typedOutputBudget); sequence = item.sequence;
      }
      const args = resolveArguments(item.args, observations, { nodeProfile: request.schemaVersion === 2 });
      const observation = args.some((arg) => arg === undefined)
        ? request.schemaVersion === 2
          ? { id: item.id, outcome: "unsupported", reason: "referenced-result-unavailable",
            invocationTrace: { ...item.invocation, ...(item.invocation.kind === "call" ? { exportName: item.exportName ?? request.exportName } : {}), outcome: "unsupported" },
            services: { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 } }
          : { id: item.id, outcome: "unsupported", reason: "referenced-result-unavailable" }
        : await session.execute({ ...item, args });
      cases.push(observation);
      observations.set(item.id, observation);
      if (observation.outcome === "error") {
        timeoutReason = [CPU_EXHAUSTED, WALL_EXHAUSTED].includes(observation.reason) ? observation.reason : undefined;
        status = timeoutReason ? "timeout" : "error";
        break;
      }
    }
  } finally { disposeSession(); }
  if (status === "completed" && performance.now() >= deadline) { status = "timeout"; timeoutReason = WALL_EXHAUSTED; }
  const output = JSON.stringify(request.schemaVersion === 1
    ? { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest, status, cases, ...(timeoutReason ? { timeoutReason } : {}) }
    : { schemaVersion: 2, workerVersion: NODE_WORKER_VERSION, profileDigest: request.profile.digest, requestDigest, status, cases,
      ...(timeoutReason ? { timeoutReason } : {}), services: cases.reduce((total, item) => {
        for (const key of Object.keys(total)) total[key] += item.services?.[key] ?? 0; return total;
      }, { calls: 0, rawBytes: 0, textBytes: 0, decodersCreated: 0, timersScheduled: 0, denials: 0 }),
      quiescence, ...(timerTrace.length ? { timerTrace } : {}) });
  if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) throw new Error("Response size exceeded");
  process.stdout.write(output);
} catch {
  // Do not echo candidate code, thrown objects, or local environment details.
  process.stderr.write("isolated-contract-worker-failed\n");
  process.exitCode = 1;
}
