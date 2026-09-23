import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import type { AuthenticatedAssessment } from "../../extensions/acceptance-authenticated-admission.js";
import { openHostContractConfiguration, independentRequestAdmissionBlock } from "../../extensions/acceptance-host-configuration.js";
import { captureCompositeExecutionSnapshot } from "../../extensions/acceptance-execution-snapshot.js";
import { registerIndependentAcceptanceProvider } from "../../extensions/acceptance-independent-registry.js";
import { durableTaskContractMatches, workingTreeSnapshot } from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../../extensions/task-lifecycle.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import { openCompositeAssuranceJournal, openCompositeAssuranceRuntime, sealCompositePlanContext } from "./runtime-assurance-facts.ts";
import { compareConfigDocumentLiterals, compareIncidentClaims, comparePolicyRefusalOutput } from "../../../../adapters/common/structured-assurance-facts.mjs";
import { createCompositeCodeChildCollector, createRuntimeContractRunner } from "./runtime-contract-runner.ts";
import { capturePersistedAssistantResponse, commitCompositeWebUiDelivery, persistedAssistantResponseObservation, webUiDeliveryObservation } from "./composite-session-persistence.ts";
import { openScopedMediationEvidence, scopedMediationFactObservation } from "./composite-scoped-mediation.ts";
import { compositeTaskPublicationDigest, openCompositeTaskPublicationStore, recoverCompositeTaskPublication } from "./composite-task-publication.ts";
import { assertCompositeCriterion, compositePhaseHeadDigest, compositeSettlementTaskStatus, compositeTaskContractDigest, projectCompositeLifecycle } from "./composite-runtime-binding.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import type { CompletionPreparation } from "./completion-preparation.ts";
type ResponseObservation = { origin: "assistant"; bytes: string }; type DeferredCompletionFinalizer = { preflight: () => object | false; publication: (capability: object) => object | false; finalize: (capability: object) => boolean };
type Options = { state: RuntimeSessionState; installedRoot: string; configPath?: string;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined; authorizeSourceRead: (ctx: ExtensionContext, sourcePath: string) => boolean; writeTask?: (cwd: string, task: TaskContract) => TaskContract };
type CompositeItem = { contract: any; plan: any; declarations: any; producer: any; authority: any;
  receipts: Map<string, any>; codeChildren: Map<string, ReturnType<typeof createCompositeCodeChildCollector>>; preparation?: object;
  aggregatePreparation?: any; aggregate?: object; publication?: object };
type Entry = { configuration?: ReturnType<typeof openHostContractConfiguration>; dispose: () => void;
  controller: AbortController; block?: string; stop?: { reason: string; attemptId?: string }; hasComposite: boolean;
  compositeReason?: string; composites: CompositeItem[];
  response?: ResponseObservation; persistedResponse?: object; persistenceError?: string;
  finalizer?: DeferredCompletionFinalizer; provisional?: boolean;
  runners: Array<{ contract: any; runner: ReturnType<typeof createRuntimeContractRunner>; receipt?: AuthenticatedAssessment }>;
  pending?: Promise<void> };
const STRUCTURED_MODULE = fileURLToPath(new URL("../../../../adapters/common/structured-assurance-facts.mjs", import.meta.url)); const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const exact = (value: any, fields: string[]) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function stableFile(file: string, maximum: number): Buffer {
  if (fs.realpathSync.native(file) !== file) throw new Error("Producer path is not canonical");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error("Producer file is unsafe");
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor), atPath = fs.lstatSync(file);
    if (bytes.length !== before.size || atPath.isSymbolicLink()
      || ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(field => before[field] !== after[field] || after[field] !== atPath[field])) {
      throw new Error("Producer file changed during read");
    }
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function loadStructuredProducer(installedRoot: string) {
  const root = fs.realpathSync.native(installedRoot), manifestPath = path.join(root, "adapters/common/assurance-producers.json");
  const modulePath = path.join(root, "adapters/common/structured-assurance-facts.mjs");
  if (fs.realpathSync.native(modulePath) !== fs.realpathSync.native(STRUCTURED_MODULE)) throw new Error("Loaded producer is not the installed producer");
  const manifestBytes = stableFile(manifestPath, 1024 * 1024), moduleBytes = stableFile(modulePath, 512 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!exact(manifest, ["schemaVersion", "manifestVersion", "suiteContract", "status", "authority", "activation",
    "producerResultsMayGrantPass", "producers", "qualification"])
    || manifest.schemaVersion !== 1 || manifest.manifestVersion !== "assurance-producers-v1"
    || manifest.suiteContract !== "production-v2-da2" || manifest.status !== "provider-free-qualified"
    || manifest.authority !== "host-runtime-content-facts" || manifest.activation !== "host-composite-content-v1"
    || manifest.producerResultsMayGrantPass !== false || !Array.isArray(manifest.producers) || manifest.producers.length !== 1
    || !exact(manifest.qualification, ["state", "approvedDesignVectorCount", "runtimeActivation", "remainingConjunctsAreHostAuthenticated"])
    || manifest.qualification.state !== "provider-free-qualified" || manifest.qualification.approvedDesignVectorCount !== 34
    || manifest.qualification.runtimeActivation !== true || manifest.qualification.remainingConjunctsAreHostAuthenticated !== true) {
    throw new Error("Structured producer manifest is not qualified for host content facts");
  }
  const producer = manifest.producers[0];
  if (!exact(producer, ["id", "module", "digest", "authority", "activation", "kinds", "ruleDigests", "allowedImports",
    "forbiddenCapabilities", "rules"]) || producer.id !== "structured-assurance-facts-v1"
    || producer.module !== "adapters/common/structured-assurance-facts.mjs" || producer.digest !== sha(moduleBytes)
    || producer.authority !== "none" || producer.activation !== "host-composite-content-v1"
    || JSON.stringify(producer.kinds) !== JSON.stringify(["structured-log-claims", "config-document-literals", "policy-refusal-output"])
    || !Array.isArray(producer.rules) || producer.rules.length !== 4) throw new Error("Structured producer identity is invalid");
  const rules = new Map();
  for (const rule of producer.rules) {
    if (!exact(rule, ["id", "kind", "exportName", "ruleDigest", "definition"]) || !producer.kinds.includes(rule.kind)
      || !producer.ruleDigests.includes(rule.ruleDigest) || rule.ruleDigest !== sha(JSON.stringify(rule.definition))
      || rules.has(rule.ruleDigest)) throw new Error("Structured producer rule identity is invalid");
    rules.set(rule.ruleDigest, rule);
  }
  return Object.freeze({ manifestDigest: sha(manifestBytes), producer, rules });
}
function pureObservation(item: CompositeItem, fact: any, snapshot: any, response: ResponseObservation) {
  const rule = item.producer.rules.get(fact.ruleDigest), producer = item.producer.producer;
  if (!rule || fact.producerId !== producer.id || fact.producerDigest !== producer.digest || fact.kind !== rule.kind) {
    throw new Error("Composite fact is not bound to the installed producer rule");
  }
  const p = fact.parameters, d = rule.definition, materials = new Map(snapshot.materials.map((material: any) => [material.id, material]));
  let result: any;
  if (fact.kind === "structured-log-claims") {
    if (p.responseFormat !== d.responseFormat || p.correlation !== d.correlation) throw new Error("Incident rule parameters changed");
    result = compareIncidentClaims((materials.get(p.logMaterialId) as any)?.text, response.bytes, p.logMaterialId);
  } else if (fact.kind === "config-document-literals") {
    if (p.format !== d.format || JSON.stringify(p.requiredFields) !== JSON.stringify(d.requiredFields)) throw new Error("Document rule parameters changed");
    result = compareConfigDocumentLiterals((materials.get(p.configMaterialId) as any)?.text,
      (materials.get(p.documentMaterialId) as any)?.text);
  } else if (fact.kind === "policy-refusal-output") {
    if (p.rule !== d.rule || p.expectedDisposition !== d.expectedDisposition || p.responseFormat !== d.responseFormat
      || p.nativeTemplateSetDigest !== d.nativeTemplateSetDigest) throw new Error("Refusal rule parameters changed");
    result = comparePolicyRefusalOutput(p.rule, response.bytes, response.origin);
  } else throw new Error("Composite fact has no pure structured producer");
  if (!result || result.authority !== "none" || ![true, false, null].includes(result.matched)) throw new Error("Producer returned an invalid observation");
  const observationDigest = sha(JSON.stringify({ factId: fact.id, result, materials: snapshot.identities,
    responseDigest: sha(response.bytes) }));
  if (result.matched === true) return { status: "pass", observationDigest, counterexampleRef: null, reasonCodes: [] };
  if (result.matched === false) return { status: "fail", observationDigest,
    counterexampleRef: sha(JSON.stringify(result)), reasonCodes: ["content-mismatch"] };
  return { status: "unknown", observationDigest, counterexampleRef: null,
    reasonCodes: [String(result.reason ?? "").startsWith("ambiguous-") ? "ambiguous-input" : "unsupported-input"] };
}
async function settleCompositeFact(item: CompositeItem, fact: any, collect: () => any): Promise<void> {
  const reserved = item.authority.runtime.reserveFact(fact.id);
  if (reserved.status === "current") { item.receipts.set(fact.id, reserved.receipt); return; }
  if (reserved.status !== "reserved") throw new Error(`Composite fact ${fact.id} is ${reserved.status}`);
  const receipt = await item.authority.runtime.settleFact({ reservation: reserved.reservation,
    producer: item.authority.runtime.producerFor(fact.id), collect });
  item.receipts.set(fact.id, receipt);
}
function exactResponse(observed: ReturnType<typeof persistedAssistantResponseObservation>, operationRef: string,
  messageRequestId: string) {
  return { origin: "assistant", entryId: observed.entryId, digest: observed.digest, byteLength: observed.byteLength,
    operationRef, messageRequestId };
}
function settlementObservation(fact: any, response: any, matched: boolean, details: any,
  reason: "persistence-mismatch" | "delivery-mismatch") {
  return { status: matched ? "pass" : "fail", observationDigest: sha(JSON.stringify({ factId: fact.id, details })),
    counterexampleRef: matched ? null : sha(JSON.stringify(details)), reasonCodes: matched ? [] : [reason], response };
}
function liveCompositeAssessment(item: CompositeItem, provisional: boolean, responseFile?: string) {
  const decision = provisional ? { verdict: "pass", reasons: ["provisional-full-gate-preflight"] }
    : item.authority.runtime.assess([...item.receipts.values()]);
  const pass = decision.verdict === "pass";
  return { version: "live-composite-assessment-v1", verdict: decision.verdict, completionAllowed: pass,
    repairEligible: false, sourceMutationAllowed: false, assurance: pass ? "bounded-composite-contract-tested" : "none",
    reasons: decision.reasons ?? [], failedChecks: decision.failedFactIds ?? [], missingChecks: decision.missingFactIds ?? [],
    criterionId: item.contract.criterionId, criterionHash: item.contract.criterionHash,
    sourcePath: item.authority.filePath, sourcePaths: [...new Set([item.authority.filePath, item.authority.anchorPath,
      ...(responseFile ? [responseFile] : [])])],
    factKinds: item.contract.facts.map((fact: any) => fact.kind) };
}
function persistedAssistantResponseObservationSafe(capability?: object) {
  try { return capability ? persistedAssistantResponseObservation(capability) : undefined; }
  catch { return undefined; }
}
function openCompositeAuthority(configuration: ReturnType<typeof openHostContractConfiguration>, contract: any,
  binding: any, currentBinding: () => any) {
  return configuration.withCompositeAuthority({ contract, binding, create: ({ key, directory, projectRoot, compiled,
    contractText, declarations, maxAttempts }: any) => {
    const sealedContext = sealCompositePlanContext({ key, contractText, declarations, binding, maxAttempts });
    const identity = sha(JSON.stringify([binding.taskRunId, binding.sessionId, binding.criterionId,
      binding.criterionHash, binding.runtimeGeneration, sealedContext.contextDigest]));
    const filePath = path.join(directory, `composite-${identity}.jsonl`);
    const journal = openCompositeAssuranceJournal({ filePath, projectRoot, key, contextDigest: sealedContext.contextDigest });
    let closed = false;
    try {
      const runtime = openCompositeAssuranceRuntime({ key, sealedContext, journal, currentBinding: () => {
        if (!configuration.isCurrent()) throw new Error("Composite host approval changed");
        return currentBinding();
      } });
      const publicationStore = openCompositeTaskPublicationStore({ key, directory, projectRoot });
      return Object.freeze({ compiled, sealedContext, runtime, filePath, anchorPath: journal.anchorPath, publicationStore,
        close() { if (closed) return; closed = true; journal.close(); } });
    } catch (error) { journal.close(); throw error; }
  } });
}
/** Approved host configuration is opt-in; there is no model-authored oracle. */
export class IndependentAcceptanceRuntime {
  readonly #options: Options;
  readonly #entries = new Map<string, Entry>();
  readonly #active = new Map<string, { token: symbol; generation: number }>();
  readonly #retiring = new Map<string, Promise<void>>();
  #nextGeneration = 0;
  constructor(options: Options) { this.#options = options; }
  #key(ctx: ExtensionContext, task: TaskContract) { return `${ctx.cwd}\0${task.sessionId}\0${task.taskRunId}`; }
  #session(ctx: ExtensionContext) { return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}\0`; }
  async #recoverPublication(ctx: ExtensionContext) {
    const options = this.#options, task = options.activeTask(ctx); if (!options.configPath || !task) return;
    let configuration: ReturnType<typeof openHostContractConfiguration>; try { configuration = openHostContractConfiguration({ configPath: options.configPath,
      projectRoot: ctx.cwd, installedRoot: options.installedRoot }); } catch { return; }
    try {
      const approved = configuration.forRequest(task.operatorRequestDigest); if (!approved?.contracts.some((contract: any) => contract.route === "composite")) return;
      const store = configuration.withCompositeRecovery((authority: any) => openCompositeTaskPublicationStore(authority));
      const record: any = store.read(task.taskRunId, task.sessionId); if (!record) return;
      if (!options.writeTask) throw new Error("Composite task publication writer is unavailable");
      const completed = recoverCompositeTaskPublication({ store, record, task,
        currentWorkingTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(ctx.cwd)),
        expectedCriteria: approved.contracts.filter((contract: any) => contract.route === "composite"),
        cwd: ctx.cwd, writeTask: options.writeTask });
      options.state.cacheTaskIdentity(ctx, completed);
    } finally { configuration.close(); }
  }
  async activate(ctx: ExtensionContext): Promise<void> {
    const prefix = this.#session(ctx);
    while (this.#retiring.has(prefix)) await this.#retiring.get(prefix);
    if (this.#active.has(prefix)) return;
    this.#active.set(prefix, { token: Symbol("session-lifetime"), generation: ++this.#nextGeneration });
    try { await this.#recoverPublication(ctx); } catch (error) { this.#active.delete(prefix); throw error; }
    while (this.#active.size > 100) await this.#retireSession(this.#active.keys().next().value as string);
  }
  async #retire(entry: Entry): Promise<void> {
    entry.block = "independent verification is stopping"; entry.controller.abort();
    try { await entry.pending; } finally { entry.dispose(); entry.configuration?.close(); }
  }
  #retireSession(prefix: string): Promise<void> {
    this.#active.delete(prefix);
    const pending = this.#retiring.get(prefix); if (pending) return pending;
    const retiring: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) if (key.startsWith(prefix)) {
      this.#entries.delete(key); retiring.push(this.#retire(entry));
    }
    if (!retiring.length) return Promise.resolve();
    const settled = Promise.all(retiring).then(() => {}).finally(() => {
      if (this.#retiring.get(prefix) === settled) this.#retiring.delete(prefix);
    });
    this.#retiring.set(prefix, settled); return settled;
  }
  async prepare(ctx: ExtensionContext, task: TaskContract, response?: ResponseObservation): Promise<CompletionPreparation | false> {
    const options = this.#options, prefix = this.#session(ctx), lifetime = this.#active.get(prefix);
    const fence = () => {
      try { return lifetime !== undefined && this.#active.get(prefix)?.token === lifetime.token && this.#session(ctx) === prefix
        && task.sessionId === ctx.sessionManager.getSessionId() && options.activeTask(ctx)?.taskRunId === task.taskRunId; }
      catch { return false; }
    };
    const ready = Object.freeze({ isCurrent: fence, completion: "ready" as const });
    const deferred = (reason: string) => Object.freeze({ isCurrent: fence, completion: "deferred" as const, reason });
    if (!fence()) return false;
    if (!options.configPath || task.trace.outcome !== "pending") return ready;
    const key = this.#key(ctx, task); let entry = this.#entries.get(key);
    if (!entry) {
      entry = { dispose: () => {}, runners: [], composites: [], hasComposite: false, controller: new AbortController() };
      const owned = entry;
      const unregister = registerIndependentAcceptanceProvider(ctx.cwd, task, {
        read(_projected: TaskContract, digest: string, issue: (entry: any, assessment: any) => object) {
          if (owned.controller.signal.aborted) return { block: "independent verification is stopping", stopReason: "stopping" };
          if (owned.block) return { block: owned.block, stopReason: "approval" };
          if (!owned.configuration?.isCurrent()) return { block: "independent host approval or installed verifier changed", stopReason: "approval" };
          if (owned.stop) return { block: `independent verification is blocked: ${owned.stop.reason}`,
            stopReason: owned.stop.reason, stopAttemptId: owned.stop.attemptId };
          const actual = owned.composites.every(item => ["settled", "completed"].includes(item.authority.runtime.state().phase));
          if (owned.hasComposite && !owned.provisional && !actual) return { block: owned.compositeReason
            ?? "composite assurance settlement is pending", stopReason: "pending" };
          const active = options.activeTask(ctx), snapshot = captureWorkspaceVerificationSnapshot(ctx.cwd);
          const projectVerificationDigest = active && snapshot.digest === digest
            ? options.state.projectVerification.currentDigest(ctx, active, snapshot, undefined, { completedProjection: true }) : null;
          const entries = owned.runners.map(item => ({ ...item.contract, receipt: item.receipt }));
          for (const item of owned.composites) { const assessment = liveCompositeAssessment(item,
            owned.provisional === true, persistedAssistantResponseObservationSafe(owned.persistedResponse)?.file);
            entries.push({ ...item.contract, assessment: issue(item.contract, assessment) }); }
          return { entries, projectVerificationDigest };
        },
        webUiSettlementApplicability: () => owned.hasComposite ? "composite" : "not-applicable",
        settleWebUi: (_projected: TaskContract, input: any) => this.#settleWebUi(ctx, task, owned, input)
      });
      owned.dispose = () => { unregister(); for (const item of owned.composites) {
        try { if (!["completed", "cancelled", "superseded"].includes(item.authority.runtime.state().phase)) item.authority.runtime.invalidate("cancelled"); } catch {}
        item.authority.close();
      } };
      this.#entries.set(key, owned);
      while (this.#entries.size > 100) {
        const oldest = this.#entries.keys().next().value as string, removed = this.#entries.get(oldest)!;
        this.#entries.delete(oldest); await this.#retire(removed);
      }
      if (owned.controller.signal.aborted || !fence()) { if (this.#entries.get(key) === owned) this.#entries.delete(key); await this.#retire(owned); return false; }
      try {
        const configuration = openHostContractConfiguration({ configPath: options.configPath, projectRoot: ctx.cwd, installedRoot: options.installedRoot });
        owned.configuration = configuration;
        const approvedRequest = configuration.forRequest(task.operatorRequestDigest);
        if (!approvedRequest || approvedRequest.nativeOnly === true) { owned.block = independentRequestAdmissionBlock(approvedRequest, task); return ready; }
        for (const contract of approvedRequest.contracts) {
          if (!task.acceptanceReceipt?.criteria.some(criterion => criterion.id === contract.criterionId && criterion.hash === contract.criterionHash)) {
            throw new Error("Approved criterion mismatch");
          }
          if (contract.route === "composite") {
            owned.hasComposite = true;
            const plan = contract.planContext, compiledContract = JSON.parse(plan.contractText), declarations = JSON.parse(plan.declarationsText);
            assertCompositeCriterion(task, compiledContract);
            const producer = loadStructuredProducer(options.installedRoot);
            const protectedPaths = new Set(plan.materialBindings.filter((binding: any) => binding.mode === "protected").map((binding: any) => binding.relativePath));
            const currentBinding = () => {
              const active = options.activeTask(ctx); if (!active || active.taskRunId !== task.taskRunId) throw new Error("Composite task is not current");
              assertCompositeCriterion(active, compiledContract);
              const snapshot = captureCompositeExecutionSnapshot({ projectRoot: ctx.cwd, materialBindings: plan.materialBindings, declarations });
              if (loadStructuredProducer(options.installedRoot).manifestDigest !== producer.manifestDigest) throw new Error("Composite producer manifest changed");
              const verification = captureWorkspaceVerificationSnapshot(ctx.cwd, { isProtectedProjectPath: (candidate: string) =>
                protectedPaths.has((path.isAbsolute(candidate) ? path.relative(ctx.cwd, candidate) : candidate).split(path.sep).join("/")) });
              const verifierDigest = compiledContract.facts.some((fact: any) => fact.kind === "project-verifier-current")
                ? options.state.projectVerification?.currentDigest?.(ctx, active, verification) ?? null : null;
              return { projectId: snapshot.projectId, projectHead: snapshot.projectHead, sourceDigest: snapshot.sourceDigest,
                materialSnapshotDigest: snapshot.materialSnapshotDigest, suiteDigest: plan.identity.suiteDigest,
                configDigest: plan.identity.configDigest, armDigest: plan.identity.armDigest, taskRunId: active.taskRunId,
                sessionId: active.sessionId, operatorRequestDigest: active.operatorRequestDigest!, taskContractDigest: compositeTaskContractDigest(active),
                criterionIndex: compiledContract.criterionIndex, criterionId: compiledContract.criterionId,
                criterionHash: compiledContract.criterionHash, runtimeGeneration: lifetime!.generation,
                phaseHeadDigest: compositePhaseHeadDigest(ctx.cwd, active), producerManifestDigest: producer.manifestDigest, verifierDigest };
            };
            const authority = openCompositeAuthority(configuration, contract, currentBinding(), currentBinding);
            const recovered = authority.runtime.reissue();
            if (recovered.completed) throw new Error("Completed composite journal has a nonterminal task contract");
            const codePlans = new Map(authority.compiled.codePlans.map((item: any) => [item.digest, item])), codeChildren = new Map();
            for (const fact of authority.compiled.contract.facts.filter((item: any) => item.kind === "bounded-code-checks")) {
              const codePlan: any = codePlans.get(fact.parameters.codePlanDigest); if (!codePlan) throw new Error("Composite code child plan is missing");
              codeChildren.set(fact.id, createCompositeCodeChildCollector({ state: options.state, context: ctx,
                getTask: () => options.activeTask(ctx), approved: { store: configuration.store, ...approvedRequest.backend,
                  verifierDigest: approvedRequest.verifierDigest, authorizeSourceRead: ({ sourcePath }: any) =>
                    configuration.isCurrent() && options.authorizeSourceRead(ctx, sourcePath) },
                plan: codePlan, fact, criterionId: contract.criterionId, criterionHash: contract.criterionHash,
                maxAttempts: contract.maxAttempts }));
            }
            owned.composites.push({ contract: authority.compiled.contract, plan, declarations, producer, authority,
              codeChildren,
              receipts: new Map(recovered.facts.map((receipt: any) => [receipt.factId, receipt])),
              ...(recovered.preparation ? { preparation: recovered.preparation } : {}),
              ...(recovered.aggregate ? { aggregate: recovered.aggregate } : {}) });
            continue;
          }
          const sourcePaths = new Set([contract.sourcePath, ...(contract.modulePaths ?? [])]);
          const runner = createRuntimeContractRunner({ state: options.state, context: ctx, getTask: () => options.activeTask(ctx),
            approved: { store: configuration.store, sourcePath: contract.sourcePath, modulePaths: contract.modulePaths, exportName: contract.exportName,
              checks: contract.checks, ...approvedRequest.backend, verifierDigest: approvedRequest.verifierDigest,
              authorizeSourceRead: ({ sourcePath }) => (!sourcePaths.has(sourcePath) || configuration.isCurrent()) && options.authorizeSourceRead(ctx, sourcePath) } });
          owned.runners.push({ contract, runner });
        }
      } catch { owned.block = "independent host approval, composite identity, or installed producer is unavailable"; }
    }
    if (entry.controller.signal.aborted || !fence()) return false;
    if (entry.block || !entry.configuration?.isCurrent()) return entry.hasComposite ? deferred(entry.block ?? "composite approval changed") : ready;
    if (entry.pending) { await entry.pending; return !entry.controller.signal.aborted && fence()
      ? entry.hasComposite ? deferred(entry.compositeReason ?? "composite settlement is pending") : ready : false; }
    const owned = entry; owned.stop = undefined;
    const pending = (async () => {
      for (const item of owned.runners) {
        if (owned.controller.signal.aborted) break;
        try {
          const result = await item.runner.run({ scope: { taskRunId: task.taskRunId, criterionId: item.contract.criterionId },
            criterionHash: item.contract.criterionHash, maxAttempts: item.contract.maxAttempts, signal: owned.controller.signal });
          const reason = ({ "evidence-pending": "pending", "evidence-interrupted": "interrupted", "evidence-exhausted": "exhausted" } as Record<string, string>)[result.reason];
          const observed = result.evidence?.observed;
          const executionThrew = observed !== null && typeof observed === "object" && "reason" in observed && observed.reason === "independent-execution-threw";
          if (reason || executionThrew) { owned.stop = { reason: reason ?? "unavailable", attemptId: result.attemptId }; item.receipt = undefined; break; }
          item.receipt = await item.runner.assess(result, { policy: "allow" });
        } catch { item.receipt = undefined; owned.stop = { reason: "unavailable" }; break; }
      }
      if (!owned.hasComposite) return;
      if (!response || response.origin !== "assistant" || typeof response.bytes !== "string" || !(response.bytes as any).isWellFormed()
        || Buffer.byteLength(response.bytes) > 65_536) { owned.compositeReason = "composite actual assistant response is unavailable"; return; }
      if (owned.response && (owned.response.origin !== response.origin || owned.response.bytes !== response.bytes)) {
        owned.block = "a different composite response was already observed"; return;
      }
      owned.response = Object.freeze({ origin: response.origin, bytes: response.bytes });
      for (const item of owned.composites) {
        for (const fact of item.contract.facts.filter((candidate: any) => candidate.kind === "bounded-code-checks")) {
          const child = item.codeChildren.get(fact.id); if (!child) throw new Error("Composite code child is unavailable");
          await settleCompositeFact(item, fact, () => child.collect(task, owned.controller.signal));
        }
        const snapshot = captureCompositeExecutionSnapshot({ projectRoot: ctx.cwd,
          materialBindings: item.plan.materialBindings, declarations: item.declarations });
        for (const fact of item.contract.facts.filter((candidate: any) => item.producer.producer.kinds.includes(candidate.kind))) {
          await settleCompositeFact(item, fact, async () => pureObservation(item, fact, snapshot, response));
        }
        const statuses = Object.values(item.authority.runtime.state().factStatuses);
        owned.compositeReason = statuses.includes("error") ? "composite content producer failed"
          : statuses.includes("fail") ? "composite content counterexample observed"
            : "composite mediation, persistence, and terminal delivery facts are pending";
      }
    })();
    owned.pending = pending;
    try { await pending; } catch { owned.block = "independent composite producer execution is unavailable"; }
    finally { if (owned.pending === pending) owned.pending = undefined; }
    if (owned.controller.signal.aborted || !fence()) return false;
    return owned.hasComposite ? deferred(owned.compositeReason ?? owned.block ?? "composite settlement is pending") : ready;
  }
  deferCompletion(ctx: ExtensionContext, task: TaskContract, response: ResponseObservation,
    finalizer: DeferredCompletionFinalizer): boolean {
    const entry = this.#entries.get(this.#key(ctx, task));
    if (!entry?.hasComposite || entry.controller.signal.aborted || !entry.response
      || response.origin !== entry.response.origin || response.bytes !== entry.response.bytes
      || typeof finalizer?.preflight !== "function" || typeof finalizer?.publication !== "function"
      || typeof finalizer?.finalize !== "function") return false;
    if (entry.finalizer && entry.finalizer !== finalizer) return false;
    entry.finalizer = finalizer; return true;
  }
  projectLifecycle(ctx: ExtensionContext, task: TaskContract, candidate: TaskContract): TaskContract | false {
    const entry = this.#entries.get(this.#key(ctx, task));
    if (!entry?.hasComposite || entry.controller.signal.aborted || !entry.configuration?.isCurrent()
      || candidate.taskRunId !== task.taskRunId || candidate.sessionId !== task.sessionId) return false;
    const ready = entry.composites.every(item => { const state = item.authority.runtime.state();
      return ["settled", "completed"].includes(state.phase) || entry.provisional === true && item.preparation
        && item.contract.facts.filter((fact: any) => fact.stage === "content").every((fact: any) => state.factStatuses[fact.id] === "pass"); });
    return ready ? projectCompositeLifecycle(candidate, entry.composites.flatMap(item => item.contract.facts.map((fact: any) => fact.kind))) : false;
  }
  observeTurnEnd(ctx: ExtensionContext, message: any): void {
    try {
      const task = this.#options.activeTask(ctx); if (!task) return;
      const entry = this.#entries.get(this.#key(ctx, task));
      if (!entry?.hasComposite || !entry.response || entry.persistedResponse || entry.controller.signal.aborted) return;
      entry.persistedResponse = capturePersistedAssistantResponse({ cwd: ctx.cwd, sessionId: task.sessionId,
        manager: ctx.sessionManager, message, expectedText: entry.response.bytes });
      entry.persistenceError = undefined;
    } catch (error) {
      const task = this.#options.activeTask(ctx), entry = task && this.#entries.get(this.#key(ctx, task));
      if (entry?.hasComposite) entry.persistenceError = error instanceof Error ? error.message : "native response persistence unavailable";
    }
  }
  async #settleWebUi(ctx: ExtensionContext, originalTask: TaskContract, owned: Entry, input: any) {
    const blocked = (reason: string) => ({ status: "blocked", reason });
    try {
      if (owned.pending) await owned.pending;
      const active = this.#options.activeTask(ctx);
      if (!active || active.taskRunId !== originalTask.taskRunId || active.sessionId !== originalTask.sessionId
        || active.trace.outcome !== "pending" || owned.controller.signal.aborted || !owned.configuration?.isCurrent()) {
        return blocked("composite task authority is not current");
      }
      if (!input || typeof input !== "object" || !ID.test(input.operationRef) || !ID.test(input.messageRequestId)
        || input.manager !== ctx.sessionManager || typeof input.evidence !== "function") {
        return blocked("native WebUI settlement evidence is invalid");
      }
      if (!owned.persistedResponse || owned.persistenceError || !owned.response || !owned.finalizer) {
        return blocked("native response persistence or completion finalizer is unavailable");
      }
      const persisted = persistedAssistantResponseObservation(owned.persistedResponse);
      const response = exactResponse(persisted, input.operationRef, input.messageRequestId);
      const brokerEvidence = await input.evidence();
      const captures = owned.composites.map(item => ({ item, snapshot: captureCompositeExecutionSnapshot({
        projectRoot: ctx.cwd, materialBindings: item.plan.materialBindings, declarations: item.declarations }) }));
      const workspace = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      for (const { item, snapshot } of captures) {
        const mediation = openScopedMediationEvidence(brokerEvidence, { projectRoot: ctx.cwd, task: active,
          operationRef: input.operationRef, messageRequestId: input.messageRequestId, plan: item.plan,
          contract: item.contract, materials: snapshot.materials });
        for (const fact of item.contract.facts.filter((candidate: any) => ["tool-policy-complete", "context-current",
          "workspace-scope", "project-verifier-current"].includes(candidate.kind))) {
          await settleCompositeFact(item, fact, async () => scopedMediationFactObservation(mediation,
            { fact, plan: item.plan, contract: item.contract, task: active, materials: snapshot.materials, workspace }));
        }
        if (item.authority.runtime.assessContent([...item.receipts.values()]).verdict !== "pass") {
          return blocked("composite content or mediation facts did not pass");
        }
        item.preparation = item.authority.runtime.prepareResponse({ facts: [...item.receipts.values()],
          bytes: owned.response.bytes, origin: owned.response.origin, entryId: persisted.entryId,
          operationRef: input.operationRef, messageRequestId: input.messageRequestId });
        const persistenceFact = item.contract.facts.find((fact: any) => fact.kind === "response-persisted");
        if (!persistenceFact) return blocked("composite response persistence fact is missing");
        await settleCompositeFact(item, persistenceFact, async () => settlementObservation(persistenceFact, response, true,
          { entryId: persisted.entryId, digest: persisted.digest, byteLength: persisted.byteLength,
            fileDigest: persisted.fileDigest }, "persistence-mismatch"));
      }
      let finalization: object | false, target: any;
      owned.provisional = true;
      try { finalization = owned.finalizer.preflight(); target = finalization && owned.finalizer.publication(finalization); }
      finally { owned.provisional = false; }
      if (!finalization || !target || target.version !== "composite-terminal-task-target-v1"
        || target.terminalTaskDigest !== compositeTaskPublicationDigest(target.terminalTask)) {
        return blocked("full completion preflight did not pass");
      }
      const deliveryKey = sha(JSON.stringify(["piagent-composite-terminal-delivery-v1", active.taskRunId,
        active.sessionId, input.operationRef, input.messageRequestId, persisted.entryId, persisted.digest]));
      const delivered = commitCompositeWebUiDelivery({ response: owned.persistedResponse, manager: input.manager,
        taskRunId: active.taskRunId, operationRef: input.operationRef, messageRequestId: input.messageRequestId,
        idempotencyKey: deliveryKey });
      const delivery = webUiDeliveryObservation(delivered);
      for (const { item } of captures) {
        const deliveryFact = item.contract.facts.find((fact: any) => fact.kind === "terminal-delivery");
        if (!deliveryFact) return blocked("composite terminal delivery fact is missing");
        await settleCompositeFact(item, deliveryFact, async () => settlementObservation(deliveryFact, response, true,
          { operationRef: delivery.operationRef, messageRequestId: delivery.messageRequestId,
            confirmationEntryId: delivery.confirmationEntryId, confirmationDigest: delivery.confirmationDigest },
          "delivery-mismatch"));
      }
      for (const { item } of captures) item.aggregatePreparation = item.authority.runtime.prepareAggregatePublication({
        preparation: item.preparation, facts: [...item.receipts.values()], taskPublicationDigest: target.terminalTaskDigest });
      const publicationStore = captures[0]?.item.authority.publicationStore;
      if (!publicationStore) return blocked("composite publication store is unavailable");
      const publicationRecord = publicationStore.prepare({ pendingTask: target.pendingTask,
        terminalTask: target.terminalTask, workingTreeDigest: target.workingTreeDigest,
        entries: captures.map(({ item }) => item.aggregatePreparation.entry) });
      for (const { item } of captures) {
        item.aggregate = item.authority.runtime.settleAggregate({ publication: item.aggregatePreparation.publication });
        item.publication = item.authority.runtime.prepareTaskCompletion({ aggregate: item.aggregate });
      }
      if (!owned.finalizer.finalize(finalization)) return blocked("terminal task publication failed");
      const completed = this.#options.activeTask(ctx);
      if (!completed || completed.taskRunId !== active.taskRunId || completed.sessionId !== active.sessionId
        || completed.trace.outcome !== "completed" || !durableTaskContractMatches(ctx.cwd, completed)) {
        return blocked("terminal task contract is not durably persisted");
      }
      for (const { item } of captures) item.authority.runtime.completeTask({ aggregate: item.aggregate,
        publication: item.publication });
      publicationStore.complete(publicationRecord);
      const taskStatus = compositeSettlementTaskStatus(owned.composites.flatMap(item => item.contract.facts.map((fact: any) => fact.kind)));
      owned.compositeReason = undefined; return { status: "settled", taskStatus };
    } catch {
      return blocked("composite settlement unavailable");
    }
  }
  clear(ctx: ExtensionContext): Promise<void> { return this.#retireSession(this.#session(ctx)); }
}
