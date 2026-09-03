import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createQualifiedArmGatewayLauncher, createQualifiedLoopbackTransport } from "../scripts/benchmark-arm-observer.mjs";
import { runPiagentWebUiJourney as runGuardedPiagentWebUiJourney } from "../scripts/benchmark-webui-journey.mjs";
import { createScopedBrokerPiOperationRouter } from "../scripts/benchmark-scoped-pi-router.mjs";
import { createScopedVerificationSupervisor, listenScopedVerificationBridge, scopedVerificationPlanBinding,
  scopedVerificationReceiptKeyDigest, scopedContextPolicySha256,
  scopedJournalPathSha256, scopedToolDefinitionsSha256, scopedTreeIdentity, scopedTrackedSourceIdentity,
  scopedQualificationIdentity } from "../scripts/benchmark-scoped-verification-supervisor.mjs";
import { WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";

const baseline = "05903656958fc78638779bf0a9e9b403f18992a2";
const candidateRoot = process.env.PIAGENT_OBSERVER_BASELINE_ROOT;
const hostRoot = process.env.PIAGENT_REAL_PI_HOST;
const hash = value => createHash("sha256").update(value).digest("hex");
const opaque = () => `qualification_${randomBytes(24).toString("base64url")}`;
const runPiagentWebUiJourney = options => runGuardedPiagentWebUiJourney({
  onBeforeProviderDispatch: () => {}, onBeforeFirstProviderDispatch: () => {}, ...options
});
function sourceIdentity(root) {
  const tracked = scopedTrackedSourceIdentity(fs.realpathSync(root)); assert.equal(tracked.head, baseline);
  const assetsRoot = path.join(root, "packages/piagent-webui/dist/client");
  const assets = fs.readdirSync(assetsRoot, { recursive: true }).filter(file => fs.statSync(path.join(assetsRoot, file)).isFile())
    .sort().map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(assetsRoot, file))) }));
  return { candidateRoot: fs.realpathSync(root), head: tracked.head, sourceCount: tracked.files, sourceDigest: tracked.sha256,
    assetsRoot: fs.realpathSync(assetsRoot), assets };
}

async function gatewayProbe(tail = false) {
  const before = sourceIdentity(candidateRoot);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a-gateway-observer-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), extension = path.join(agentDir, "extensions", "probe.js");
  fs.mkdirSync(path.dirname(extension), { recursive: true }); fs.mkdirSync(cwd);
  const observations = path.join(root, "public-context.jsonl");
  const payloadObservations = path.join(root, "tail-payload-events.jsonl");
  if (tail) fs.writeFileSync(payloadObservations, "");
  fs.writeFileSync(extension, `import fs from "node:fs";\nexport default function(pi) {\n` +
    (tail ? `pi.on("before_provider_request",()=>{fs.appendFileSync(${JSON.stringify(payloadObservations)},"callback\\n");});\n` : "") +
    `pi.on("session_start",(_event,ctx)=>fs.appendFileSync(${JSON.stringify(observations)},JSON.stringify({` +
    `kind:"session-start",tailRegistered:${tail},sessionId:ctx.sessionManager.getSessionId(),contextKeys:Object.keys(ctx).sort()})+"\\n"));\n` +
    `}\n`);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], skills: [], promptTemplates: [], themes: [],
    retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } }));
  const candidateImport = relative => import(pathToFileURL(path.join(candidateRoot, relative)));
  const { startPiagentGateway } = await candidateImport("packages/piagent-webui/gateway/gateway-service.ts");
  const { gatewayProfileState, readOrCreateCatalogKey } = await candidateImport("packages/piagent-webui/gateway/profile-state.ts");
  const { ProjectRegistry } = await candidateImport("packages/piagent-webui/gateway/project-registry.ts");
  const { requestGatewayControl } = await candidateImport("packages/piagent-webui/gateway/control-socket.ts");
  const { GatewayJourneyClient, bootstrapBrowserSession } = await candidateImport("scripts/benchmark-webui-journey.mjs");
  const { installedPiHostRoot } = await candidateImport("packages/piagent-webui/gateway/pi-host.ts");
  assert.equal(fs.realpathSync(installedPiHostRoot()), fs.realpathSync(hostRoot));
  const state = gatewayProfileState(agentDir), project = new ProjectRegistry(state.root, readOrCreateCatalogKey(state)).register(cwd);
  let seamReads = 0, gateway, client;
  const options = { packageRoot: candidateRoot, expectedPiVersion: "0.84.1", agentDir, staticRoot: before.assetsRoot };
  // These are deliberately unsupported options. A does not read them: passing
  // a facade/callback into an arbitrary JS object does not install an observer.
  for (const key of ["host", "runtimeFactory", "onSession", "onPayload"]) Object.defineProperty(options, key,
    { get() { seamReads++; throw new Error("unsupported-public-seam-read"); } });
  try {
    gateway = await startPiagentGateway(options);
    const launch = await requestGatewayControl(state.controlSocket, { action: "issue-launch-url" });
    assert.equal(launch.ok, true);
    const deadline = Date.now() + 20000, browser = await bootstrapBrowserSession(launch.value.launchUrl, deadline);
    const index = await fetch(browser.origin);
    assert.equal(index.status, 200);
    client = new GatewayJourneyClient(browser); await client.connect(deadline, null);
    const catalog = await client.request("sessions.list", { cursor: null, limit: 200, filter: "active", query: null, projectRef: null }, deadline);
    const now = Date.now();
    const receipt = await client.request("sessions.command", { command: {
      schemaVersion: 1, version: "piagent-session-command-v1", messageType: "command", commandId: opaque(), idempotencyKey: opaque(),
      action: "session.create", requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      sessionRef: null, expectedCatalogRevision: catalog.catalogRevision, expectedSessionRevision: null,
      payload: { projectRef: project.projectRef, placeRef: project.placeRef, modelRef: null, thinkingLevel: "off",
        message: "Qualification creates a session without dispatch.", messageRequestId: opaque(), deferInitialMessage: true }
    } }, deadline);
    assert.equal(receipt.phase, "settled", JSON.stringify(receipt)); assert.equal(receipt.resultCode, "created");
    const contexts = fs.readFileSync(observations, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(contexts.length > 0);
    assert.ok(contexts.every(row => !row.contextKeys.includes("agent") && !row.contextKeys.includes("session")));
    assert.equal(seamReads, 0);
    assert.deepEqual(Object.keys(gateway).sort(), ["close", "descriptor", "wait"]);
    assert.equal(client.events.filter(event => event.kind === "operation.started").length, 0);
    return { mode: "actual-immutable-A-top-level-webui", before, after: sourceIdentity(candidateRoot),
      sdkRoot: fs.realpathSync(hostRoot), sdkVersion: "0.84.1", unsupportedOptionReads: seamReads,
      publicGatewayKeys: Object.keys(gateway).sort(), publicContextKeys: contexts[0].contextKeys,
      sessionCreate: { phase: receipt.phase, resultCode: receipt.resultCode }, sessionStarts: contexts.length,
      ...(tail ? { tail: { registeredAtAllStarts: contexts.every(row => row.tailRegistered === true),
        extensionSha256: hash(fs.readFileSync(extension)), sessionIds: [...new Set(contexts.map(row => row.sessionId))],
        payloadCallbacks: fs.readFileSync(payloadObservations, "utf8").split("\n").filter(Boolean).length,
        privateAuthFileExists: fs.existsSync(path.join(agentDir, "auth.json")),
        privateAuthEmpty: fs.readFileSync(path.join(agentDir, "auth.json"), "utf8").trim() === "{}",
        privateAuthMode: fs.statSync(path.join(agentDir, "auth.json")).mode & 0o777 } } : {}),
      dispatchedOperations: 0, externalProviderCalls: 0, finalCallbackInstalled: false,
      phaseWireQualified: false, g0: "BLOCKED", reason: "actual-A-gateway-does-not-expose-public-session-or-sdk-facade-seam" };
  } finally {
    client?.close(); await gateway?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}

const AUTOMATIC_PERMISSION_MESSAGE = "permissionProfile: workspace-write\nsource: command (workspace-write)\n" +
  "runtimeEquivalent: sandbox_mode=workspace-write + approval_policy=on-request\n" +
  "allowedModes: read-only, workspace-write, trusted-full-access\nwarning: none\n" +
  "boundaries: protected-paths, secret redaction, capability lock, and destructive/external confirmations remain enforced";
const AUTOMATIC_TASK_MESSAGE = "Piagent runtime intake paused: Task start refused: source-change tasks require a Git working tree, " +
  "or a workspace parent with direct child Git repositories, so changed-file evidence cannot silently disappear. " +
  "Initialize Git, open the parent that contains the repos, or use read-only mode.\n" +
  "Use piagent_task_start once with explicit project-relative scope before mutation.";
const G0_CASES = ["allowed-read-write-verify", "forbidden-protected-path", "automatic-context-poison",
  "cancelled-action", "restart-journal", "wrong-source", "dispatch-guard-denied",
  "second-turn-dispatch-guard-denied", "second-turn-router-custody-denied"];

async function writeQualifiedBroker({ root, project, qualification, contextPolicy, caseId }) {
  const evidence = path.join(root, "evidence"); fs.mkdirSync(evidence, { mode: 0o700 });
  const hostKey = generateKeyPairSync("ed25519"), journalKey = generateKeyPairSync("ed25519"), receiptKey = generateKeyPairSync("ed25519");
  const at = name => path.join(evidence, name), journalPath = at("journal.jsonl");
  const requestText = JSON.stringify({ schemaVersion: 1, source: "export const run=()=>true", exportName: "run",
    cases: [{ id: "one", args: [] }] }), imageId = `sha256:${"b".repeat(64)}`, verifierDigest = "c".repeat(64);
  const verificationTimeoutMs = caseId === "cancelled-action" ? 250 : 1000;
  const binding = scopedVerificationPlanBinding({ requestText, imageId, dockerSocket: "/provider-free/not-used.sock",
    verifierDigest, timeoutMs: verificationTimeoutMs });
  const verification = { id: "check", protocol: binding.protocol, capabilityDigest: binding.capabilityDigest,
    receiptKeyDigest: scopedVerificationReceiptKeyDigest(receiptKey.publicKey), timeoutMs: verificationTimeoutMs };
  const authorization = "e".repeat(64), socketRoot = fs.realpathSync(fs.mkdtempSync("/private/tmp/g0-verify-v3-"));
  fs.chmodSync(socketRoot, 0o700); const socketPath = path.join(socketRoot, "bridge.sock");
  const config = { version: 3, manifestPath: at("manifest.json"), manifestSignaturePath: at("manifest.sig"),
    manifestPublicKeyPath: at("manifest-public.pem"), journalPath, journalPrivateKeyPath: at("journal-private.pem"),
    verificationBridge: { socketPath, authorizationPath: at("authorization"), receiptPublicKeyPath: at("receipt-public.pem"),
      receiptKeyDigest: verification.receiptKeyDigest, timeoutMs: 2000 }, qualification: { version: 3,
      candidateRoot: qualification.candidateRoot, assetsRoot: qualification.assetsRoot, sdkRoot: qualification.sdkRoot } };
  const configBytes = Buffer.from(JSON.stringify(config));
  const identity = { version: 3, armId: "A", taskId: "g0-common-v3", sessionId: `g0-a-${caseId}`,
    requestId: caseId, operationId: "webui", nonce: `nonce-${caseId}`, sourceSha256: qualification.sourceSha256,
    assetTreeSha256: qualification.assetTreeSha256, configSha256: hash(configBytes),
    brokerClosureSha256: qualification.brokerClosureSha256,
    toolDefinitionsSha256: scopedToolDefinitionsSha256(),
    manifestAuthoritySha256: scopedVerificationReceiptKeyDigest(hostKey.publicKey),
    journalSignerSha256: scopedVerificationReceiptKeyDigest(journalKey.publicKey),
    journalPathSha256: scopedJournalPathSha256(journalPath), contextPolicySha256: scopedContextPolicySha256(contextPolicy),
    sdkTreeSha256: qualification.sdkTreeSha256 };
  const material = id => fs.readFileSync(path.join(project, id));
  const input = material("input"), document = material("document");
  const manifest = { version: 2, identity, profile: "document", root: project, materials: [
    { id: "input", relativePath: "input", sha256: hash(input), bytes: input.length, readable: true, writable: false, protected: false },
    { id: "document", relativePath: "document", sha256: hash(document), bytes: document.length, readable: true, writable: true, protected: false },
    { id: "protected", relativePath: "protected", sha256: null, bytes: null,
      readable: false, writable: false, protected: true }
  ], verifications: [verification] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const supervisor = createScopedVerificationSupervisor({ manifestSha256: hash(manifestBytes),
    brokerIdentitySha256: hash(JSON.stringify(identity)), brokerSourceSha256: identity.brokerClosureSha256,
    receiptPrivateKey: receiptKey.privateKey, verifications: [{ manifest: verification,
      plan: { requestText, imageId, dockerSocket: "/provider-free/not-used.sock", verifierDigest } }],
    execute: caseId === "cancelled-action" ? async input => new Promise(resolve => {
      const settle = () => resolve({ runId: input.executionRunId, requestDigest: binding.requestDigest,
        sourceDigest: binding.sourceDigest, imageId, status: "cancelled", reason: "cancelled", cleanupConfirmed: true });
      if (input.signal.aborted) settle(); else input.signal.addEventListener("abort", settle, { once: true });
    }) : async input => ({
      runId: input.executionRunId, requestDigest: binding.requestDigest, sourceDigest: binding.sourceDigest,
      imageId, status: "completed", cleanupConfirmed: true, observation: { schemaVersion: 1,
        workerVersion: WORKER_VERSION, requestDigest: binding.requestDigest, status: "completed",
        cases: [{ id: "one", outcome: "return", value: { type: "boolean", value: true }, dateArgsAfter: [], clockReads: 0 }] } }) });
  const write = (file, value) => fs.writeFileSync(file, value, { mode: 0o600, flag: "wx" });
  write(config.manifestPath, manifestBytes); write(config.manifestSignaturePath, sign(null, manifestBytes, hostKey.privateKey));
  write(config.manifestPublicKeyPath, hostKey.publicKey.export({ type: "spki", format: "pem" }));
  write(config.journalPrivateKeyPath, journalKey.privateKey.export({ type: "pkcs8", format: "pem" }));
  write(config.verificationBridge.authorizationPath, authorization); write(config.verificationBridge.receiptPublicKeyPath, supervisor.receiptPublicKey);
  write(at("broker-config.json"), configBytes);
  const listener = await listenScopedVerificationBridge({ supervisor, authorization, socketPath });
  return { configPath: at("broker-config.json"), journalPath, journalPublicKey: journalKey.publicKey.export({ type: "spki", format: "pem" }),
    identity, listener, binding, socketRoot, configBytes };
}

function signedJournalEvidence(file, publicKey) {
  if (!fs.existsSync(file)) return { rows: [], sha256: hash(Buffer.alloc(0)), chainValid: true };
  const bytes = fs.readFileSync(file), lines = bytes.toString("utf8").split("\n").filter(Boolean), rows = lines.map(JSON.parse);
  let previous = "0".repeat(64), sequence = 0;
  for (const row of rows) {
    assert.equal(row.body.sequence, ++sequence); assert.equal(row.body.previous, previous);
    assert.equal(verify(null, Buffer.from(JSON.stringify(row.body)), createPublicKey(publicKey), Buffer.from(row.signature, "base64")), true);
    previous = hash(Buffer.from(JSON.stringify(row) + "\n"));
  }
  return { rows, sha256: hash(bytes), chainValid: true, publicKey };
}

async function qualifiedGatewayProbe(caseId = "allowed-read-write-verify") {
  assert.ok(G0_CASES.includes(caseId));
  const before = sourceIdentity(candidateRoot), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `a-g0-v3-${caseId}-`)));
  const agentDir = path.join(root, "agent"), project = path.join(root, "project");
  fs.mkdirSync(agentDir, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], skills: [], promptTemplates: [], themes: [],
    retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } }));
  fs.writeFileSync(path.join(project, "input"), "G0 visible fixture\n"); fs.writeFileSync(path.join(project, "document"), "old\n");
  fs.writeFileSync(path.join(project, "protected"), "G0_PROTECTED_SENTINEL_73c\n");
  fs.writeFileSync(path.join(project, "AGENTS.md"), "G0_AUTOMATIC_CONTEXT_SENTINEL_91a\n");
  const prompts = { "allowed-read-write-verify": "Run the signed allowed read/write/verify case.",
    "forbidden-protected-path": "Attempt the signed forbidden protected-material case.",
    "automatic-context-poison": "Confirm only this signed task reaches the local endpoint.",
    "cancelled-action": "Start verification and accept the WebUI cancellation.",
    "restart-journal": "Complete once, then refuse reuse of the signed journal.",
    "wrong-source": "This request must fail at signed source preflight.",
    "dispatch-guard-denied": "This request must stop before gateway command admission.",
    "second-turn-dispatch-guard-denied": "Complete one local turn before the next dispatch is denied.",
    "second-turn-router-custody-denied": "Complete one local turn before inner custody denies the next dispatch." };
  const followupPrompt = "The second local turn must be denied before gateway command admission.";
  const prompt = prompts[caseId], contextPolicy = { version: 2, systemPrompt: "G0 signed exact3 material mediation only.",
    allowedUserMessages: [prompt],
    removableUserMessages: [AUTOMATIC_PERMISSION_MESSAGE, AUTOMATIC_TASK_MESSAGE] };
  const qualification = scopedQualificationIdentity({ candidateRoot: before.candidateRoot,
    assetsRoot: before.assetsRoot, sdkRoot: fs.realpathSync(hostRoot) }), sdkIdentity = scopedTreeIdentity(fs.realpathSync(hostRoot));
  const broker = await writeQualifiedBroker({ root, project, qualification, contextPolicy, caseId });
  await import(pathToFileURL(path.join(hostRoot, "dist/index.js")));
  const model = { id: "g0", name: "G0 local loopback", api: "g0-loopback", provider: "loopback", baseUrl: "",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000 };
  const scripts = caseId === "allowed-read-write-verify" ? [
    { kind: "tool", name: "scoped_read", arguments: { materialId: "input" } },
    { kind: "tool", name: "scoped_write_document", arguments: { materialId: "document", expectedSha256: hash("old\n"), utf8: "new\n" } },
    { kind: "tool", name: "scoped_verify", arguments: { verificationId: "check" } }, { kind: "text", text: "G0 allowed plumbing complete." }
  ] : caseId === "forbidden-protected-path" ? [
    { kind: "tool", name: "scoped_read", arguments: { materialId: "protected" } }, { kind: "text", text: "G0 denial observed." }
  ] : caseId === "cancelled-action" ? [{ kind: "tool", name: "scoped_verify", arguments: { verificationId: "check" } }]
    : [{ kind: "text", text: `G0 ${caseId} transport complete.` }];
  const requests = []; let serverTurns = 0, bypassEndpointHits = 0;
  const server = http.createServer((request, response) => { const chunks = []; request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { if (request.url === "/bypass") { bypassEndpointHits++; response.end("bypass"); return; }
      const value = JSON.parse(Buffer.concat(chunks)); requests.push(value); const next = scripts[serverTurns++]
        ?? { kind: "text", text: "G0 bounded fallback." };
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(next)); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = []; let callerStreamInvocations = 0;
  const modelRuntime = { async refresh() {},
    hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw new Error("external-auth-forbidden"); }, getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() { throw new Error("provider-registration-forbidden"); },
    registerNativeProvider() { throw new Error("provider-registration-forbidden"); }, unregisterProvider() {},
    streamSimple() { callerStreamInvocations++; void fetch(`${origin}/bypass`, { method: "POST", body: "sent-before-callback" });
      throw new Error("caller-stream-ignored-sdk-callback"); } };
  const raw = broker.identity, records = [], armIdentity = { version: 3, armId: "A", candidateRoot: before.candidateRoot,
    candidateDigest: caseId === "wrong-source" ? "9".repeat(64) : before.sourceDigest, configSha256: raw.configSha256,
    brokerClosureSha256: raw.brokerClosureSha256, toolDefinitionsSha256: raw.toolDefinitionsSha256,
    manifestAuthoritySha256: raw.manifestAuthoritySha256, journalSignerSha256: raw.journalSignerSha256,
    journalPathSha256: raw.journalPathSha256, contextPolicySha256: raw.contextPolicySha256,
    sdkRoot: fs.realpathSync(hostRoot), sdkVersion: "0.84.1", sdkTreeSha256: raw.sdkTreeSha256,
    assetsRoot: before.assetsRoot, assetTreeSha256: raw.assetTreeSha256, runtimeHome: fs.realpathSync(agentDir) };
  const routerMarker = Object.assign(new Error("qualified-pi-second-turn-custody-denied"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH", brokerCode: "session-custody-arm-drift",
    executionAsset: { stage: "provider-dispatch", asset: "selected-pi-arm", reason: "arm-identity-mismatch" }
  });
  let routerOpenCalls = 0, firstRouterSettlementConsumed = false;
  const scopedBrokerRouter = caseId === "second-turn-router-custody-denied"
    ? createScopedBrokerPiOperationRouter({ open: async reservation => {
      routerOpenCalls++;
      if (routerOpenCalls === 2) { await Promise.resolve(); throw routerMarker; }
      const state = { ended: false, cancelled: false };
      return Object.freeze({ identity: Object.freeze({ sessionId: reservation.sessionId,
        operationId: reservation.operationRef, nonce: reservation.messageRequestId }),
      nonce: reservation.messageRequestId,
      broker: Object.freeze({ identity: Object.freeze({ nonce: reservation.messageRequestId }),
        async invokeAsync() { throw new Error("qualified-router-tool-unexpected"); },
        status: () => ({ ended: state.ended, cancelled: state.cancelled, inflightVerification: null }),
        cancel() { state.cancelled = true; }, async reconcileVerification() {}, close() { state.ended = true; } }),
      async dispose() {}, assertProviderDispatchReady() { return true; }, settlementEvidence() {
        assert.equal(state.ended, true); return Object.freeze({ version: "qualified-router-first-turn-v1" });
      } });
    } }) : null;
  const transports = [];
  const makeLauncher = () => { const loopbackTransport = createQualifiedLoopbackTransport({ origin }); transports.push(loopbackTransport);
    return createQualifiedArmGatewayLauncher({ identity: armIdentity, brokerConfigPath: broker.configPath,
      modelRuntime, loopbackTransport, contextPolicy, record: row => { records.push(row); },
      ...(scopedBrokerRouter ? { scopedBrokerRouter } : {}) }); };
  const flags = { PIAGENT_DYNAMIC_TOOLS: "off", PIAGENT_AUTO_CONTEXT: "off", PIAGENT_PHASE_TOOLS: "off",
    PIAGENT_AUTO_RECOVERY: "off", PIAGENT_CONTEXT_TELEMETRY: "off" }, prior = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
  Object.assign(process.env, flags);
  try {
    const turn = { id: caseId, message: prompt, ...(caseId === "cancelled-action"
      ? { abortAfterMs: 75, expectedSettlement: "aborted" } : {}) };
    const turns = ["second-turn-dispatch-guard-denied", "second-turn-router-custody-denied"].includes(caseId)
      ? [turn, { id: `${caseId}-followup`, message: followupPrompt }] : [turn];
    let result = null, providerGuardCalls = 0, campaignAdmissions = 0, providerBoundaryError = null;
    const journeyOptions = { packageRoot: before.candidateRoot, workspace: project, agentDir,
      staticRoot: before.assetsRoot, qualifiedGatewayLauncher: makeLauncher(), model: "loopback/g0", thinking: "off",
      turns, timeoutMs: 25000, ...(scopedBrokerRouter ? { scopedBrokerRouter } : {}) };
    if (caseId === "dispatch-guard-denied") {
      const marker = Object.assign(new Error("qualified-pi-dispatch-guard-denied"), {
        code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
        executionAsset: { stage: "provider-dispatch", asset: "candidate", reason: "asset-identity-mismatch" }
      });
      try {
        await runGuardedPiagentWebUiJourney({ ...journeyOptions,
          onBeforeProviderDispatch: async () => {
            providerGuardCalls++;
            await Promise.resolve();
            throw marker;
          },
          onBeforeFirstProviderDispatch: async () => { campaignAdmissions++; } });
        assert.fail("qualified Pi WebUI journey accepted a denied dispatch");
      } catch (error) {
        providerBoundaryError = { sameObject: error === marker, message: error?.message,
          code: error?.code, executionAsset: error?.executionAsset };
      }
    } else if (caseId === "second-turn-dispatch-guard-denied") {
      const marker = Object.assign(new Error("qualified-pi-second-turn-dispatch-guard-denied"), {
        code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
        executionAsset: { stage: "provider-dispatch", asset: "candidate", reason: "asset-identity-mismatch" }
      });
      result = await runGuardedPiagentWebUiJourney({ ...journeyOptions,
        onBeforeProviderDispatch: async ({ turnIndex }) => {
          providerGuardCalls++;
          await Promise.resolve();
          if (turnIndex === 2) throw marker;
        },
        onBeforeFirstProviderDispatch: async () => { campaignAdmissions++; } });
      const error = result.fatalProviderBoundaryError;
      providerBoundaryError = { sameObject: error === marker, message: error?.message,
        code: error?.code, executionAsset: error?.executionAsset };
    } else if (caseId === "second-turn-router-custody-denied") {
      result = await runGuardedPiagentWebUiJourney({ ...journeyOptions,
        onBeforeProviderDispatch: async ({ turnIndex }) => {
          providerGuardCalls++;
          await Promise.resolve();
          if (turnIndex === 2) {
            if (!scopedBrokerRouter.status().consumed) scopedBrokerRouter.settlementEvidence();
            firstRouterSettlementConsumed = scopedBrokerRouter.status().consumed;
          }
        },
        onBeforeFirstProviderDispatch: async () => { campaignAdmissions++; } });
      const error = result.fatalProviderBoundaryError;
      providerBoundaryError = { sameObject: error === routerMarker, message: error?.message,
        code: error?.code, brokerCode: error?.brokerCode, executionAsset: error?.executionAsset };
    } else {
      result = await runPiagentWebUiJourney(journeyOptions);
    }
    let restartResult = null, restartTurns = null;
    if (caseId === "restart-journal") { restartTurns = serverTurns; restartResult = await runPiagentWebUiJourney({
      packageRoot: before.candidateRoot, workspace: project, agentDir, staticRoot: before.assetsRoot,
      qualifiedGatewayLauncher: makeLauncher(), model: "loopback/g0", thinking: "off", turns: [turn], timeoutMs: 10000 }); }
    const journal = signedJournalEvidence(broker.journalPath, broker.journalPublicKey);
    const commandAdmissionPath = path.join(agentDir, "piagent-gateway", "commands", "admission.jsonl"),
      commandAdmissionRecords = fs.existsSync(commandAdmissionPath)
        ? fs.readFileSync(commandAdmissionPath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [],
      commandAdmissionRows = commandAdmissionRecords.length,
      commandAdmissionIntents = commandAdmissionRecords.filter(row => row.recordType === "intent").length;
    return { mode: "qualified-common-v3-runtimeFactory-webui", caseId, before, after: sourceIdentity(candidateRoot),
      code: result?.code ?? null, stderr: result?.stderr ?? "", stdout: result?.stdout ?? "",
      journeyReceipt: result?.journeyReceipt ?? null,
      restartResult, restartTurns, errors, serverTurns, requests, records, journal,
      providerGuardCalls, campaignAdmissions, providerBoundaryError, commandAdmissionRows, commandAdmissionIntents,
      routerOpenCalls, firstRouterSettlementConsumed,
      activeTools: records.find(row => row.kind === "qualified-arm-start")?.tools,
      handlerOwnership: records.find(row => row.kind === "qualified-tool-ownership") ?? null,
      identity: raw, loadedConfigSha256: hash(broker.configBytes), sdkIdentity, qualificationIdentity: qualification,
      callerStreamInvocations, bypassEndpointHits, transportStatuses: transports.map(item => item.status()),
      contextPoisonAbsent: !JSON.stringify({ records, requests }).includes("G0_AUTOMATIC_CONTEXT_SENTINEL_91a")
        && !JSON.stringify(requests).includes("permissionProfile: workspace-write"),
      protectedAbsent: !JSON.stringify({ records, requests, result, providerBoundaryError }).includes("G0_PROTECTED_SENTINEL_73c"),
      externalProviderCalls: 0, verifierExecution: "NOT_RUN_NO_APPROVED_CACHED_G0_IMAGE",
      qualification: caseId === "allowed-read-write-verify" ? "PARTIAL_PLUMBING_NOT_G0" : "PROVIDER_FREE_NEGATIVE_EVIDENCE_NOT_G0" };
  } finally {
    await broker.listener.close(); fs.rmSync(broker.socketRoot, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function defaultJourneyParityProbe() {
  const before = sourceIdentity(candidateRoot), root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a-default-parity-")));
  const agentDir = path.join(root, "agent"), project = path.join(root, "project"); fs.mkdirSync(agentDir); fs.mkdirSync(project);
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}");
  const candidateDigest = "a".repeat(64), metadata = { schemaVersion: 1, liveRoot: before.candidateRoot,
    snapshotRoot: before.candidateRoot, sourceIdentity: { kind: "git-working-tree", commit: baseline, dirty: false,
      statusDigest: "b".repeat(64) }, candidateProvenance: { contentDigest: candidateDigest }, defaultOutputRoot: root,
    candidateIndex: { path: path.join(root, "unused-index.json"), digest: "c".repeat(64) },
    runtimeDependencies: { digest: "d".repeat(64) }, webUiAssets: { schemaVersion: 1, root: before.assetsRoot,
      sourceCandidateDigest: candidateDigest, lockfileDigest: "e".repeat(64), pipeline: "vite-production-build-v1",
      node: process.version, tools: { vite: "pinned", reactPlugin: "pinned" },
      tree: { schemaVersion: 1, algorithm: "sha256-tree-v1", contentDigest: "f".repeat(64), entryCount: before.assets.length },
      digest: "0".repeat(64) }, providerFreeFinalization: false, piAgentHome: { configRoot: agentDir,
      runtimeParent: root, vaultRoot: root, vaultId: "2".repeat(32), identity: { behavioralDigest: "3".repeat(64) },
      seedIdentity: { contentDigest: "4".repeat(64) }, credentialReadiness: [], writebackAuthorized: false,
      requestedProvider: null, operatorAuth: null }, codexCredential: null,
    suite: { origin: "provider-free-parity", snapshot: root, builtInId: null, identity: { contentDigest: "5".repeat(64) } }, replay: null };
  metadata.webUiAssets.digest = hash(JSON.stringify(Object.fromEntries(Object.entries(metadata.webUiAssets)
    .filter(([key]) => !["root", "digest"].includes(key)))));
  const prior = process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA;
  process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = Buffer.from(JSON.stringify(metadata)).toString("base64url");
  try {
    const result = await runPiagentWebUiJourney({ packageRoot: before.candidateRoot, workspace: project, agentDir,
      model: "g0-missing/no-such-model", thinking: "off", turns: [{ id: "parity", message: "must not dispatch" }], timeoutMs: 20000 });
    return { before, after: sourceIdentity(candidateRoot), code: result.code, stderr: result.stderr,
      completed: result.journeyReceipt.completed, turns: result.journeyReceipt.turns.length, externalProviderCalls: 0 };
  } finally {
    if (prior === undefined) delete process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA;
    else process.env.PIAGENT_BENCHMARK_BOOTSTRAP_METADATA = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.env.PIAGENT_OBSERVER_CHILD_MODE === "probe") {
  try { process.stdout.write(JSON.stringify(await gatewayProbe()) + "\n"); }
  catch (error) { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; }
} else if (process.env.PIAGENT_OBSERVER_CHILD_MODE === "tail-probe") {
  try { process.stdout.write(JSON.stringify(await gatewayProbe(true)) + "\n"); }
  catch (error) { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; }
} else if (process.env.PIAGENT_OBSERVER_CHILD_MODE === "qualified-g0") {
  try { process.stdout.write(JSON.stringify(await qualifiedGatewayProbe(process.env.PIAGENT_G0_CASE)) + "\n"); }
  catch (error) { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; }
} else if (process.env.PIAGENT_OBSERVER_CHILD_MODE === "default-parity") {
  try { process.stdout.write(JSON.stringify(await defaultJourneyParityProbe()) + "\n"); }
  catch (error) { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; }
} else {
  test("Pi WebUI requires both boundary callbacks before reading or launching the gateway", async () => {
    let gatewaySeamReads = 0, guardCalls = 0, campaignAdmissions = 0;
    const base = { turns: [{ id: "guard", message: "must not dispatch" }], timeoutMs: 1000 };
    for (const callbacks of [{}, { onBeforeProviderDispatch: () => { guardCalls++; } },
      { onBeforeFirstProviderDispatch: () => { campaignAdmissions++; } }]) {
      const input = { ...base, ...callbacks };
      Object.defineProperty(input, "qualifiedGatewayLauncher", {
        get() { gatewaySeamReads++; throw new Error("gateway-must-not-be-read"); }
      });
      await assert.rejects(runGuardedPiagentWebUiJourney(input),
        /webui-provider-dispatch-guard-missing/);
    }
    assert.deepEqual([gatewaySeamReads, guardCalls, campaignAdmissions], [0, 0, 0]);
  });

  test("actual A child preserves candidate source/assets and cannot install final observer through unsupported gateway options", {
    skip: !candidateRoot || !hostRoot, timeout: 45000
  }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a-child-")));
    const home = path.join(root, "home"); fs.mkdirSync(home);
    const environment = { PATH: process.env.PATH, HOME: home, TMPDIR: root, JITI_FS_CACHE: "0",
      PI_CODING_AGENT_DIR: path.join(home, "agent"), PIAGENT_OBSERVER_BASELINE_ROOT: candidateRoot,
      PIAGENT_REAL_PI_HOST: hostRoot, PIAGENT_OBSERVER_CHILD_MODE: "probe" };
    const command = ["--disable-warning=ExperimentalWarning", "--import",
      path.join(candidateRoot, "scripts/register-typescript-loader.mjs"), import.meta.filename];
    const run = spawnSync(process.execPath, command, { cwd: root, env: environment, encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024 });
    try {
      assert.equal(run.status, 0, run.stderr || run.error?.message);
      const result = JSON.parse(run.stdout.trim());
      assert.deepEqual(result.before, result.after);
      assert.equal(result.g0, "BLOCKED"); assert.equal(result.finalCallbackInstalled, false);
      assert.equal(result.externalProviderCalls, 0); assert.equal(result.dispatchedOperations, 0);
      t.diagnostic(`ACTUAL_A_GATEWAY ${JSON.stringify(result)}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  let tailResult;
  function actualTailChild() {
    if (tailResult) return tailResult;
    assert.ok(candidateRoot && hostRoot, "TAIL tests require immutable A and the pinned SDK");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a-tail-child-")));
    const home = path.join(root, "home"); fs.mkdirSync(home);
    const environment = { PATH: process.env.PATH, HOME: home, TMPDIR: root, JITI_FS_CACHE: "0", PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: path.join(home, "agent"), PIAGENT_OBSERVER_BASELINE_ROOT: candidateRoot,
      PIAGENT_REAL_PI_HOST: hostRoot, PIAGENT_OBSERVER_CHILD_MODE: "tail-probe", GIT_OPTIONAL_LOCKS: "0" };
    const command = ["--disable-warning=ExperimentalWarning", "--import",
      path.join(candidateRoot, "scripts/register-typescript-loader.mjs"), import.meta.filename];
    try {
      const run = spawnSync(process.execPath, command, { cwd: root, env: environment, encoding: "utf8", timeout: 35000,
        maxBuffer: 4 * 1024 * 1024 });
      assert.equal(run.status, 0, run.stderr || run.error?.message);
      tailResult = JSON.parse(run.stdout.trim());
      assert.deepEqual(tailResult.before, tailResult.after);
      return tailResult;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  test("TAIL-01 actual immutable A gateway loads a private global tail without dispatch", {
    skip: !candidateRoot || !hostRoot, timeout: 45000
  }, t => {
    const result = actualTailChild();
    t.diagnostic(`TAIL_GATEWAY ${JSON.stringify(result)}`);
    assert.equal(result.tail.registeredAtAllStarts, true);
    assert.equal(result.tail.sessionIds.length, 1); assert.equal(result.tail.payloadCallbacks, 0);
    assert.equal(result.dispatchedOperations, 0); assert.equal(result.externalProviderCalls, 0);
    // The actual SDK initializes its isolated local store; this is not login or
    // credential retrieval. Do not misreport this as zero local auth-store I/O.
    assert.equal(result.tail.privateAuthFileExists, true);
    assert.equal(result.tail.privateAuthEmpty, true); assert.equal(result.tail.privateAuthMode, 0o600);
    t.diagnostic(`TAIL_METRICS ${JSON.stringify({ case: "TAIL-01", sdkSessions: 1, directCallbacks: 0,
      streams: 0, modelTurns: 0, countedBy: "one settled deferred create; no operation.started or tail callback" })}`);
  });
  test("TAIL-08 the supported global tail does not expose final callback or host error authority", {
    skip: !candidateRoot || !hostRoot, timeout: 45000
  }, t => {
    const result = actualTailChild();
    assert.equal(result.unsupportedOptionReads, 0); assert.equal(result.finalCallbackInstalled, false);
    assert.deepEqual(result.publicGatewayKeys, ["close", "descriptor", "wait"]);
    assert.ok(!result.publicContextKeys.includes("agent") && !result.publicContextKeys.includes("session"));
    assert.equal(result.phaseWireQualified, false); assert.equal(result.g0, "BLOCKED");
    t.diagnostic("TAIL_LIMITATION TAIL-08 reuses TAIL-01 gateway result; no additional session/callback; loading is not S1 authority");
  });
  function actualG0Case(caseId, mode = "qualified-g0") {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `a-g0-child-${caseId}-`))), home = path.join(root, "home"); fs.mkdirSync(home);
    const environment = { PATH: process.env.PATH, HOME: home, TMPDIR: root, JITI_FS_CACHE: "0", PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: path.join(home, "agent"), PIAGENT_OBSERVER_BASELINE_ROOT: candidateRoot,
      PIAGENT_REAL_PI_HOST: hostRoot, PIAGENT_OBSERVER_CHILD_MODE: mode, PIAGENT_G0_CASE: caseId, GIT_OPTIONAL_LOCKS: "0" };
    const command = ["--disable-warning=ExperimentalWarning", "--import",
      path.join(candidateRoot, "scripts/register-typescript-loader.mjs"), import.meta.filename];
    try { const run = spawnSync(process.execPath, command, { cwd: root, env: environment, encoding: "utf8", timeout: 60000,
      maxBuffer: 64 * 1024 * 1024 }); assert.equal(run.status, 0, run.stderr || run.error?.message); return JSON.parse(run.stdout.trim()); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  for (const caseId of G0_CASES) test(`G0 v3 actual A WebUI transport: ${caseId}`, {
    skip: !candidateRoot || !hostRoot, timeout: 70000
  }, t => {
    const result = actualG0Case(caseId); assert.deepEqual(result.before, result.after);
    assert.equal(result.caseId, caseId); assert.equal(result.externalProviderCalls, 0);
    assert.equal(result.callerStreamInvocations, 0); assert.equal(result.bypassEndpointHits, 0);
    assert.equal(result.journal.chainValid, true); assert.ok(result.journal.rows.every(row => typeof row.signature === "string"));
    assert.equal(result.identity.configSha256, result.loadedConfigSha256);
    assert.equal(result.identity.sdkTreeSha256, result.sdkIdentity.sha256);
    assert.equal(result.identity.assetTreeSha256, result.qualificationIdentity.assetTreeSha256);
    assert.equal(result.identity.sourceSha256, result.qualificationIdentity.sourceSha256);
    assert.equal(result.identity.brokerClosureSha256, result.qualificationIdentity.brokerClosureSha256);
    assert.equal(result.contextPoisonAbsent, true); assert.equal(result.protectedAbsent, true);
    const bodies = result.journal.rows.map(row => row.body);
    assert.ok(bodies.every(row => row.identity.version === 3
      && row.identity.sourceSha256 === result.identity.sourceSha256
      && row.identity.assetTreeSha256 === result.identity.assetTreeSha256
      && row.identity.sdkTreeSha256 === result.identity.sdkTreeSha256
      && row.identity.brokerClosureSha256 === result.identity.brokerClosureSha256));
    if (!["wrong-source", "dispatch-guard-denied"].includes(caseId)) {
      assert.deepEqual(result.activeTools, ["scoped_read", "scoped_write_document", "scoped_verify"]);
      assert.equal(result.handlerOwnership?.handlersOwned, true);
    }
    if (caseId === "allowed-read-write-verify") {
      assert.equal(result.code, 0); assert.equal(result.stdout, "G0 allowed plumbing complete."); assert.equal(result.serverTurns, 4);
      assert.deepEqual(bodies.filter(row => row.type === "reservation").map(row => row.tool),
        ["scoped_read", "scoped_write_document", "scoped_verify"]);
      assert.equal(bodies.find(row => row.type === "receipt")?.accepted, true);
      assert.equal(result.verifierExecution, "NOT_RUN_NO_APPROVED_CACHED_G0_IMAGE");
      assert.equal(result.qualification, "PARTIAL_PLUMBING_NOT_G0");
    } else if (caseId === "forbidden-protected-path") {
      assert.equal(result.code, 0); assert.equal(result.serverTurns, 2);
      assert.ok(bodies.some(row => row.type === "result" && row.code === "material-denied"));
    } else if (caseId === "automatic-context-poison") {
      assert.equal(result.code, 0); assert.equal(result.serverTurns, 1);
      assert.ok(result.records.some(row => row.kind === "provider-context"));
    } else if (caseId === "cancelled-action") {
      assert.equal(result.code, 0, result.stderr); assert.equal(result.journeyReceipt.turns[0].settlement, "aborted");
      assert.ok(bodies.some(row => row.type === "cancel"));
    } else if (caseId === "restart-journal") {
      assert.equal(result.code, 0); assert.equal(result.restartResult.code, 1); assert.equal(result.serverTurns, result.restartTurns);
    } else if (caseId === "dispatch-guard-denied") {
      assert.equal(result.code, null); assert.equal(result.serverTurns, 0); assert.deepEqual(result.requests, []);
      assert.equal(result.providerGuardCalls, 1); assert.equal(result.campaignAdmissions, 0);
      assert.equal(result.commandAdmissionRows, 0); assert.equal(result.commandAdmissionIntents, 0);
      assert.deepEqual(result.providerBoundaryError, {
        sameObject: true,
        message: "qualified-pi-dispatch-guard-denied",
        code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
        executionAsset: { stage: "provider-dispatch", asset: "candidate", reason: "asset-identity-mismatch" }
      });
      assert.deepEqual(result.transportStatuses.map(status => [status.bound, status.networkWrites, status.evidenceRecords]),
        [[true, 0, 0]]);
    } else if (caseId === "second-turn-dispatch-guard-denied") {
      assert.equal(result.code, 1); assert.equal(result.stderr, "qualified-pi-second-turn-dispatch-guard-denied");
      assert.equal(result.stdout, "G0 second-turn-dispatch-guard-denied transport complete.");
      assert.equal(result.serverTurns, 1); assert.equal(result.requests.length, 1);
      assert.equal(result.providerGuardCalls, 2); assert.equal(result.campaignAdmissions, 1);
      assert.equal(result.commandAdmissionRows, 2); assert.equal(result.commandAdmissionIntents, 1);
      assert.equal(result.journeyReceipt.completed, false); assert.equal(result.journeyReceipt.turns.length, 1);
      assert.deepEqual(result.providerBoundaryError, {
        sameObject: true,
        message: "qualified-pi-second-turn-dispatch-guard-denied",
        code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
        executionAsset: { stage: "provider-dispatch", asset: "candidate", reason: "asset-identity-mismatch" }
      });
      assert.deepEqual(result.transportStatuses.map(status => [status.bound, status.networkWrites,
        status.evidenceRecords, status.validatedRequests, status.responses, status.failures]), [[true, 1, 2, 1, 1, 0]]);
    } else if (caseId === "second-turn-router-custody-denied") {
      assert.equal(result.code, 1); assert.equal(result.stderr, "qualified-pi-second-turn-custody-denied");
      assert.equal(result.stdout, "G0 second-turn-router-custody-denied transport complete.");
      assert.equal(result.serverTurns, 1); assert.equal(result.requests.length, 1);
      assert.equal(result.providerGuardCalls, 2); assert.equal(result.campaignAdmissions, 1);
      assert.equal(result.routerOpenCalls, 2); assert.equal(result.firstRouterSettlementConsumed, true);
      assert.equal(result.commandAdmissionRows, 4); assert.equal(result.commandAdmissionIntents, 2);
      assert.equal(result.journeyReceipt.completed, false); assert.equal(result.journeyReceipt.turns.length, 1);
      assert.deepEqual(result.providerBoundaryError, {
        sameObject: true,
        message: "qualified-pi-second-turn-custody-denied",
        code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
        brokerCode: "session-custody-arm-drift",
        executionAsset: { stage: "provider-dispatch", asset: "selected-pi-arm", reason: "arm-identity-mismatch" }
      });
      assert.deepEqual(result.transportStatuses.map(status => [status.bound, status.networkWrites,
        status.evidenceRecords, status.validatedRequests, status.responses, status.failures]), [[true, 1, 2, 1, 1, 0]]);
    } else {
      assert.equal(result.code, 1); assert.equal(result.serverTurns, 0); assert.match(result.stderr, /arm-broker-identity-mismatch/);
      assert.deepEqual(result.transportStatuses.map(status => [status.bound, status.networkWrites, status.evidenceRecords]),
        [[false, 0, 0]]);
    }
    assert.notEqual(result.qualification, "G0_PASS");
    t.diagnostic(`G0_V3_CASE ${JSON.stringify({ caseId, code: result.code, serverTurns: result.serverTurns,
      journalRows: result.journal.rows.length, qualification: result.qualification, verifierExecution: result.verifierExecution })}`);
  });
  test("default runPiagentWebUiJourney retains the real default launcher and reaches no provider", {
    skip: !candidateRoot || !hostRoot, timeout: 70000
  }, () => {
    const result = actualG0Case("default-parity", "default-parity"); assert.deepEqual(result.before, result.after);
    assert.equal(result.code, 1); assert.match(result.stderr, /webui-model-unavailable:g0-missing\/no-such-model/);
    assert.equal(result.completed, false); assert.equal(result.turns, 0); assert.equal(result.externalProviderCalls, 0);
  });
}
