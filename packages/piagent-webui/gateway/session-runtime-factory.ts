import path from "node:path";
import fs from "node:fs";
import { createHash, createPrivateKey, sign, verify, createPublicKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { createHostWireSession } from "../../piagent-core/runtime/session/runtime-state.ts";
import { appendJsonlBounded } from "../../piagent-core/extensions/state-retention.js";
import type { PiSessionInfo } from "./session-catalog.ts";
import { preferAuthoritativePiagentGuard } from "./extension-authority.ts";
import { rpcUiContext } from "./rpc-ui-context.ts";

export type WireOperation = { operationRef: string; messageRequestId: string | null; inputText: string };
export type RuntimeHandle = { dispose(): Promise<void>; session?: any;
  beginWireOperation?(identity: WireOperation): (reason: string) => void };
export type InitialSessionOptions = { modelRef: string | null; thinkingLevel: string };
export type RuntimeFactory = (info: PiSessionInfo, runtimeInstanceRef: string,
  sessionManager?: any, initialOptions?: InitialSessionOptions) => Promise<RuntimeHandle>;
export type ScopedBrokerRouter = { toolNames: readonly string[]; extensionFactory: (pi: any) => void;
  beginOperation(identity: WireOperation & { sessionId: string }): (reason: string) => void;
  settlementEvidence(): unknown; assertProviderDispatchReady(): true;
  discardUnusedSettlement?(identity: { sessionId: string; operationRef: string; messageRequestId: string }): void;
  takeFatalProviderBoundaryError(): Error | null;
  assertOwnership(resourceLoader: any): unknown; dispose(): Promise<void> };
const MAX_WIRE_JOURNAL_BYTES = 64 * 1024 * 1024;

function privateWireFile(file: string, cwd: string, maximum: number, sync = false) {
  const root = fs.realpathSync(cwd), absolute = path.resolve(file), parent = path.dirname(absolute);
  if (!path.isAbsolute(file) || absolute !== fs.realpathSync(absolute) || absolute === root
    || absolute.startsWith(`${root}${path.sep}`)) throw new Error("provider-wire-private-path-invalid");
  const directory = fs.lstatSync(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700)
    throw new Error("provider-wire-private-directory-invalid");
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum)
      throw new Error("provider-wire-private-file-invalid");
    const data = fs.readFileSync(fd);
    if (data.length !== stat.size || data.length > maximum) throw new Error("provider-wire-private-file-changed");
    if (sync) fs.fsyncSync(fd);
    return { absolute, data, dev: stat.dev, ino: stat.ino };
  } finally { fs.closeSync(fd); }
}

function wireConfiguration(options: { wireManifest?: unknown; signReceipt?: (material: string) => string; wireReceiptsPath?: string }, cwd: string) {
  const manifestPath = process.env.PIAGENT_WIRE_MANIFEST_PATH, expectedHash = process.env.PIAGENT_WIRE_MANIFEST_SHA256;
  const keyPath = process.env.PIAGENT_WIRE_SIGNING_KEY_PATH;
  const receiptsPath = options.wireReceiptsPath ?? process.env.PIAGENT_WIRE_RECEIPTS_PATH;
  let manifest = options.wireManifest, signer = options.signReceipt;
  if (manifest === undefined && !manifestPath && !expectedHash && !keyPath && !receiptsPath) return null;
  if (manifest === undefined) {
    if (!manifestPath || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) throw new Error("provider-wire-manifest-pin-missing");
    const source = privateWireFile(manifestPath, cwd, 4 * 1024 * 1024).data;
    if (createHash("sha256").update(source).digest("hex") !== expectedHash) throw new Error("provider-wire-manifest-pin-mismatch");
    manifest = JSON.parse(source.toString("utf8"));
  }
  if (!signer) {
    if (!keyPath) throw new Error("provider-wire-signer-missing");
    const key = createPrivateKey(privateWireFile(keyPath, cwd, 16 * 1024).data);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("provider-wire-signer-invalid");
    signer = (material: string) => sign(null, Buffer.from(material), key).toString("base64");
  }
  if (!receiptsPath) throw new Error("provider-wire-receipts-path-missing");
  const publicKey = createPublicKey({ key: Buffer.from((manifest as any)?.receiptPublicKey ?? "", "base64"), type: "spki", format: "der" });
  let previous = privateWireFile(receiptsPath, cwd, MAX_WIRE_JOURNAL_BYTES);
  let sequence = 0, previousReceiptHash: string | null = null;
  if (previous.data.length) throw new Error("provider-wire-journal-replay-required");
  return { manifest, signReceipt: signer, record: async (receipt: unknown) => {
    const envelope = receipt as { material: string; signature: string };
    if (typeof envelope?.material !== "string" || typeof envelope.signature !== "string"
      || !verify(null, Buffer.from(envelope.material), publicKey, Buffer.from(envelope.signature, "base64")))
      throw new Error("provider-wire-receipt-signature-invalid");
    const material = JSON.parse(envelope.material);
    if (material.sequence !== sequence + 1 || material.previousReceiptHash !== previousReceiptHash)
      throw new Error("provider-wire-receipt-chain-invalid");
    const current = privateWireFile(receiptsPath, cwd, MAX_WIRE_JOURNAL_BYTES), line = Buffer.from(`${JSON.stringify(receipt)}\n`);
    if (current.dev !== previous.dev || current.ino !== previous.ino || !current.data.equals(previous.data)
      || current.data.length + line.length > MAX_WIRE_JOURNAL_BYTES || fs.existsSync(`${current.absolute}.1`))
      throw new Error("provider-wire-journal-continuity-lost");
    if (!isDeepStrictEqual(appendJsonlBounded(current.absolute, receipt, { maxBytes: MAX_WIRE_JOURNAL_BYTES, mode: 0o600 }), receipt))
      throw new Error("provider-wire-receipt-truncated");
    const persisted = privateWireFile(receiptsPath, cwd, MAX_WIRE_JOURNAL_BYTES, true);
    if (persisted.dev !== current.dev || persisted.ino !== current.ino || !persisted.data.equals(Buffer.concat([current.data, line])))
      throw new Error("provider-wire-receipt-not-persisted");
    previous = persisted; sequence = material.sequence;
    previousReceiptHash = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  } };
}

export function createProductionRuntimeFactory(options: {
  host: any;
  agentDir: string;
  packageRoot: string;
  modelRuntime?: any;
  wireManifest?: unknown;
  signReceipt?: (material: string) => string;
  wireReceiptsPath?: string;
  scopedBrokerRouter?: ScopedBrokerRouter;
}): RuntimeFactory {
  return async (info, runtimeInstanceRef, sessionManager, initialOptions) => {
    const wireConfig = wireConfiguration(options, info.cwd);
    let pendingInitialOptions = initialOptions;
    let wire: ReturnType<typeof createHostWireSession> | null = null;
    const retireWire = () => { wire?.dispose(); wire = null; };
    const guard = path.join(options.packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const requested = pendingInitialOptions;
      pendingInitialOptions = undefined;
      let modelRuntime = options.modelRuntime;
      if (options.scopedBrokerRouter) {
        const streamSimple = modelRuntime?.streamSimple;
        if (typeof streamSimple !== "function") throw new Error("session-scoped-provider-boundary-unavailable");
        const guarded = Object.create(modelRuntime);
        Object.defineProperty(guarded, "streamSimple", { enumerable: true,
          value(...args: unknown[]) {
            options.scopedBrokerRouter!.assertProviderDispatchReady();
            return Reflect.apply(streamSimple, modelRuntime, args);
          } });
        modelRuntime = guarded;
      }
      const services = await options.host.createAgentSessionServices({
        cwd, agentDir, modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [guard],
          extensionsOverride: preferAuthoritativePiagentGuard(guard),
          ...(options.scopedBrokerRouter ? { noExtensions: true, noSkills: true, noPromptTemplates: true,
            noThemes: true, noContextFiles: true,
            extensionFactories: [options.scopedBrokerRouter.extensionFactory] } : {})
        }
      });
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      if (extensionErrors.length) throw new Error("session-runtime-extension-load-failed");
      options.scopedBrokerRouter?.assertOwnership(services.resourceLoader);
      const models = requested?.modelRef ? services.modelRuntime?.getAvailableSnapshot?.() ?? [] : [];
      const model = requested?.modelRef ? models.find((value: any) => webUiModelRef(String(value.provider ?? ""),
        String(value.id ?? value.modelId ?? "")) === requested.modelRef) : undefined;
      if (requested?.modelRef && !model) throw new Error("session-model-unavailable");
      const created = await options.host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        ...(model ? { model } : {}), ...(requested ? { thinkingLevel: requested.thinkingLevel } : {}),
        ...(options.scopedBrokerRouter ? { noTools: "all", tools: [...options.scopedBrokerRouter.toolNames] } : {}) });
      if (options.scopedBrokerRouter && JSON.stringify(created.session.getActiveToolNames?.())
        !== JSON.stringify(options.scopedBrokerRouter.toolNames)) throw new Error("session-scoped-tool-surface-mismatch");
      if (options.scopedBrokerRouter) {
        const agent = created.session?.agent, sdkPayload = agent?.onPayload;
        if (typeof sdkPayload !== "function") throw new Error("session-scoped-provider-boundary-unavailable");
        agent.onPayload = async (raw: unknown, model: { provider: string; id: string }) => {
          await options.scopedBrokerRouter!.assertProviderDispatchReady();
          return await sdkPayload(raw, model);
        };
      }
      if (wireConfig) {
        const session = created.session, agent = session.agent, sdkPayload = agent?.onPayload;
        if (typeof sdkPayload !== "function") throw new Error("provider-wire-final-callback-unavailable");
        let hookErrors = 0, disposed = false;
        const installWire = () => {
          retireWire();
          wire = createHostWireSession({ cwd, sessionId: sessionManager.getSessionId(), runtimeInstanceRef,
            manifest: wireConfig.manifest as Record<string, any>, signReceipt: wireConfig.signReceipt, record: wireConfig.record });
          return wire;
        };
        let ownedWire = installWire();
        agent.onPayload = async (raw: unknown, model: { provider: string; id: string }) => {
          const current = ownedWire;
          if (disposed || wire !== current) throw new Error("provider-wire-session-stale");
          const transformed = await sdkPayload(raw, model);
          const payload = structuredClone(transformed === undefined ? raw : transformed);
          if (disposed || wire !== current) throw new Error("provider-wire-session-stale");
          await current.validatePayload({ payload, model, hookErrors });
          if (disposed || wire !== current) throw new Error("provider-wire-session-stale");
          return payload;
        };
        const bindExtensions = session.bindExtensions.bind(session);
        session.bindExtensions = (bindings: any) => bindExtensions({ ...bindings, onError: (error: any) => {
          hookErrors++; bindings.onError?.(error);
        } });
        const reload = session.reload.bind(session), dispose = session.dispose.bind(session);
        session.reload = async (...args: unknown[]) => {
          if (disposed || wire !== ownedWire) throw new Error("provider-wire-session-stale");
          retireWire();
          hookErrors = 0;
          await reload(...args);
          ownedWire = installWire();
        };
        session.dispose = () => { disposed = true; ownedWire.dispose(); if (wire === ownedWire) wire = null; return dispose(); };
      }
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const manager = sessionManager ?? options.host.SessionManager.open(info.path);
    const runtime = await options.host.createAgentSessionRuntime(createRuntime, {
      cwd: info.cwd,
      agentDir: options.agentDir,
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: info.path }
    });
    const bind = async (session: any) => session.bindExtensions({ mode: "rpc", uiContext: rpcUiContext() });
    runtime.setRebindSession(bind);
    if (wireConfig) runtime.setBeforeSessionInvalidate?.(retireWire);
    if (wireConfig || options.scopedBrokerRouter) {
      runtime.beginWireOperation = (identity: WireOperation) => {
        const finishers: Array<(reason: string) => void> = [];
        try {
          if (options.scopedBrokerRouter) finishers.push(options.scopedBrokerRouter.beginOperation({
            ...identity, sessionId: manager.getSessionId() }));
          if (wireConfig) {
        if (!wire) throw new Error("provider-wire-session-unavailable");
        if (!identity.messageRequestId) throw new Error("provider-wire-operation-identity-missing");
        const current = wire, cancel = current.beginOperation({ ...identity, messageRequestId: identity.messageRequestId });
            finishers.push((reason: string) => { try { cancel(reason); } catch { current.dispose(); } });
          }
        } catch (error) { for (const finish of finishers.reverse()) try { finish("operation-start-failed"); } catch {}
          throw error; }
        return (reason: string) => { for (const finish of finishers) finish(reason); };
      };
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => { retireWire(); await options.scopedBrokerRouter?.dispose(); await dispose(); };
    }
    try { await bind(runtime.session); }
    catch (error) { await runtime.dispose().catch(() => undefined); throw error; }
    return runtime;
  };
}
