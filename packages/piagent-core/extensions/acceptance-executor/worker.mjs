import { createHash } from "node:crypto";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, WORKER_VERSION, parseRequest } from "./protocol.mjs";
import { createGuestSession } from "./guest.mjs";
import { CPU_EXHAUSTED, WALL_EXHAUSTED, REQUEST_WALL_MS } from "./budget.mjs";

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
  const results = new Map();
  let session, sequence;
  try {
    for (const item of request.cases) {
      if (performance.now() >= deadline) { status = "timeout"; timeoutReason = WALL_EXHAUSTED; break; }
      if (!session || !item.sequence || sequence !== item.sequence || item.reset) {
        session?.dispose(); session = createGuestSession(QuickJS, request, deadline); sequence = item.sequence;
      }
      const args = item.args.map((arg) => arg.type === "result" ? results.get(arg.value) : arg);
      const observation = args.some((arg) => arg === undefined)
        ? { id: item.id, outcome: "unsupported", reason: "referenced-result-unavailable" }
        : session.execute({ ...item, args });
      cases.push(observation);
      if (observation.outcome === "return") results.set(item.id, observation.value);
      if (observation.outcome === "error") {
        timeoutReason = [CPU_EXHAUSTED, WALL_EXHAUSTED].includes(observation.reason) ? observation.reason : undefined;
        status = timeoutReason ? "timeout" : "error";
        break;
      }
    }
  } finally { session?.dispose(); }
  if (status === "completed" && performance.now() >= deadline) { status = "timeout"; timeoutReason = WALL_EXHAUSTED; }
  const output = JSON.stringify({ schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest, status, cases,
    ...(timeoutReason ? { timeoutReason } : {}) });
  if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) throw new Error("Response size exceeded");
  process.stdout.write(output);
} catch {
  // Do not echo candidate code, thrown objects, or local environment details.
  process.stderr.write("isolated-contract-worker-failed\n");
  process.exitCode = 1;
}
