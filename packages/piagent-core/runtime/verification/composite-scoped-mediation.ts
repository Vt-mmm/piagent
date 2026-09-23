import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { readTaskBaselineSource } from "./acceptance-api-baseline.js";
import { readWorkspaceFile } from "../inspection/workspace-file-reader.ts";
import { workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 2_048;
const SCOPED_VERIFICATION_PROTOCOL = "scoped-isolated-contract-v1";
const SCOPED_PROJECT_VERIFICATION_PROTOCOL = "scoped-project-verifier-v1";
// Legacy receipts cover the fixed Node script groups; v3 docs receipts carry
// exact commands and signed current-document scope. Neither implies the other.
const SCOPED_PROJECT_COMMANDS = new Set(["npm run type-check", "npm run lint", "npm test", "npm run test", "npm run test:e2e"]);
const IDENTITY_V3_FIELDS = ["version", "armId", "taskId", "sessionId", "requestId", "operationId", "nonce",
  "sourceSha256", "assetTreeSha256", "configSha256", "brokerClosureSha256", "toolDefinitionsSha256",
  "manifestAuthoritySha256", "journalSignerSha256", "journalPathSha256", "contextPolicySha256", "sdkTreeSha256"];
const IDENTITY_V4_FIELDS = [
  ...IDENTITY_V3_FIELDS.slice(0, 10), "measurementConfigurationSha256", ...IDENTITY_V3_FIELDS.slice(10)
];
const TOOL_DEFINITIONS = [
  { name: "scoped_read", inputSchema: { type: "object", properties: { materialId: { type: "string" } }, required: ["materialId"], additionalProperties: false } },
  { name: "scoped_write_document", inputSchema: { type: "object", properties: { materialId: { type: "string" }, expectedSha256: { type: "string" }, utf8: { type: "string" } }, required: ["materialId", "expectedSha256", "utf8"], additionalProperties: false } },
  { name: "scoped_verify", inputSchema: { type: "object", properties: { verificationId: { type: "string" } }, required: ["verificationId"], additionalProperties: false } }
];
const snapshots = new WeakMap<object, Snapshot>();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const exact = (value: any, fields: string[]) => value && typeof value === "object" && !Array.isArray(value)
  && !types.isProxy(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

type Action = { action: number; tool: string | null; requestSha256: string | null; result: any; receipt?: any };
type Snapshot = { manifest: any; rows: any[]; actions: Action[]; profileDigest: string; armDigest: string;
  reads: Map<string, Action[]>; writes: Map<string, Action[]>; verifications: Map<string, Action[]> };
type FactInput = { fact: any; plan: any; contract: any; task: any; materials: readonly any[];
  workspace: Record<string, string>; response?: any; projectRoot?: string };

export function scopedBrokerToolDefinitionsSha256(): string { return sha(JSON.stringify(TOOL_DEFINITIONS)); }
export function scopedBrokerProfileDigest(profile: string): string {
  if (!["incident", "document", "protected-env-refusal", "destructive-history-refusal"].includes(profile))
    throw new TypeError("scoped-profile-invalid");
  return sha(JSON.stringify({ version: 1, profile, mediation: "exclusive-signed-complete-journal",
    toolDefinitionsSha256: scopedBrokerToolDefinitionsSha256() }));
}
export function scopedBrokerArmDigest(identity: any): string {
  return sha(JSON.stringify({ version: 1, armId: identity.armId, sourceSha256: identity.sourceSha256,
    assetTreeSha256: identity.assetTreeSha256, brokerClosureSha256: identity.brokerClosureSha256,
    toolDefinitionsSha256: identity.toolDefinitionsSha256, contextPolicySha256: identity.contextPolicySha256,
    sdkTreeSha256: identity.sdkTreeSha256 }));
}
function requestDigest(name: string, args: Record<string, string>) {
  const copy = Object.create(null); for (const key of Object.keys(args)) copy[key] = args[key];
  return sha(JSON.stringify({ name, args: copy }));
}
function canonicalJson(bytes: Buffer, label: string) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value = JSON.parse(text);
  if (!Buffer.from(JSON.stringify(value)).equals(bytes)) throw new Error(`${label}-noncanonical`);
  return value;
}
function validateManifest(bytes: Buffer, publicKeyDigest: string) {
  const manifest = canonicalJson(bytes, "scoped-manifest");
  const identityFields = manifest?.identity?.version === 4 ? IDENTITY_V4_FIELDS : IDENTITY_V3_FIELDS;
  if (!exact(manifest, ["version", "identity", "profile", "root", "materials", "verifications"])
    || manifest.version !== 2 || !exact(manifest.identity, identityFields) || ![3, 4].includes(manifest.identity.version)
    || identityFields.slice(1).some(field => field.endsWith("Sha256") ? !HASH.test(manifest.identity[field]) : !ID.test(manifest.identity[field]))
    || manifest.identity.journalSignerSha256 !== publicKeyDigest
    || manifest.identity.toolDefinitionsSha256 !== scopedBrokerToolDefinitionsSha256()
    || !["incident", "document", "protected-env-refusal", "destructive-history-refusal"].includes(manifest.profile)
    || typeof manifest.root !== "string" || !pathSafeRoot(manifest.root)
    || !Array.isArray(manifest.materials) || manifest.materials.length > 32
    || !Array.isArray(manifest.verifications) || manifest.verifications.length > 32) throw new Error("scoped-manifest-invalid");
  const ids = new Set(), paths = new Set();
  for (const material of manifest.materials) {
    const protectedIdentity = material?.protected === true && material.sha256 === null && material.bytes === null;
    const contentIdentity = material?.protected === false && HASH.test(material.sha256)
      && Number.isSafeInteger(material.bytes) && material.bytes >= 0 && material.bytes <= 65_536;
    if (!exact(material, ["id", "relativePath", "sha256", "bytes", "readable", "writable", "protected"])
      || !ID.test(material.id) || ids.has(material.id) || !pathSafeRelative(material.relativePath) || paths.has(material.relativePath)
      || !(protectedIdentity || contentIdentity)
      || [material.readable, material.writable, material.protected].some(value => typeof value !== "boolean")
      || material.protected && (material.readable || material.writable)) throw new Error("scoped-manifest-material-invalid");
    ids.add(material.id); paths.add(material.relativePath);
  }
  for (const item of manifest.verifications) if (!exact(item, ["id", "protocol", "capabilityDigest", "receiptKeyDigest", "timeoutMs"])
    || !ID.test(item.id) || ![SCOPED_VERIFICATION_PROTOCOL, SCOPED_PROJECT_VERIFICATION_PROTOCOL].includes(item.protocol)
    || !HASH.test(item.capabilityDigest)
    || !HASH.test(item.receiptKeyDigest) || !Number.isSafeInteger(item.timeoutMs)
    || item.timeoutMs < 25 || item.timeoutMs > 30_000) throw new Error("scoped-manifest-verification-invalid");
  return manifest;
}
function pathSafeRoot(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0");
}
function pathSafeRelative(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !path.isAbsolute(value)
    && !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== "..");
}
function parseJournal(bytes: Buffer, key: any, manifest: any) {
  if (!bytes.length || bytes.length > MAX_JOURNAL_BYTES || bytes.at(-1) !== 10) throw new Error("scoped-journal-bounds");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = source.slice(0, -1).split("\n");
  if (!lines.length || lines.length > MAX_ROWS) throw new Error("scoped-journal-row-bound");
  const rows = []; let previous = "0".repeat(64), sequence = 0;
  for (const line of lines) {
    const row = canonicalJson(Buffer.from(line), "scoped-journal-row");
    if (!exact(row, ["body", "signature"]) || typeof row.signature !== "string") throw new Error("scoped-journal-envelope-invalid");
    const signature = Buffer.from(row.signature, "base64"), bodyBytes = Buffer.from(JSON.stringify(row.body));
    if (signature.length !== 64 || !verify(null, bodyBytes, key, signature)
      || row.body?.version !== 1 || row.body.sequence !== ++sequence || row.body.previous !== previous
      || row.body.manifestSha256 !== sha(Buffer.from(JSON.stringify(manifest)))
      || !isDeepStrictEqual(row.body.identity, manifest.identity)) throw new Error("scoped-journal-chain-invalid");
    rows.push(row.body); previous = sha(Buffer.from(`${line}\n`));
  }
  return rows;
}
function validateActions(rows: any[], status: any) {
  if (rows[0]?.type !== "begin" || rows.at(-1)?.type !== "end" || rows.at(-1)?.cancelled !== false
    || rows.at(-1)?.actions !== status.actions) throw new Error("scoped-journal-terminal-invalid");
  const actions = new Map<number, Action>();
  for (const row of rows) {
    if (row.type === "reservation") {
      if (!Number.isSafeInteger(row.action) || row.action < 1 || actions.has(row.action)
        || typeof row.tool !== "string" && row.tool !== null || row.requestSha256 !== null && !HASH.test(row.requestSha256))
        throw new Error("scoped-journal-reservation-invalid");
      actions.set(row.action, { action: row.action, tool: row.tool, requestSha256: row.requestSha256, result: null });
    } else if (row.type === "receipt" && row.accepted === true) {
      const action = actions.get(row.action); if (!action || action.receipt) throw new Error("scoped-journal-receipt-invalid");
      action.receipt = row.receipt;
    } else if (row.type === "result") {
      const action = actions.get(row.action); if (!action || action.result) throw new Error("scoped-journal-result-invalid");
      if (!["observed", "denied", "error"].includes(row.outcome)
        || row.outcome === "observed" && row.effectPossible !== undefined
        || row.outcome !== "observed" && typeof row.effectPossible !== "boolean"
        || row.outcome === "denied" && row.effectPossible !== false
        || row.outcome === "error" && row.effectPossible !== true) throw new Error("scoped-journal-result-invalid");
      action.result = row;
    } else if (!["begin", "end", "verification-start", "cancel", "transport-begin", "transport-end"].includes(row.type))
      throw new Error("scoped-journal-event-invalid");
  }
  const ordered = [...actions.values()].sort((a, b) => a.action - b.action);
  if (ordered.length !== status.actions || ordered.some((item, index) => item.action !== index + 1 || !item.result))
    throw new Error("scoped-journal-action-gap");
  return ordered;
}

export function openScopedMediationEvidence(evidence: any, expected: { projectRoot: string; task: any; operationRef: string;
  messageRequestId: string; plan: any; contract: any; materials: readonly any[] }): object {
  if (!exact(evidence, ["version", "manifestBytes", "manifestSignature", "manifestPublicKey", "journalBytes",
    "journalPublicKey", "status"])
    || evidence.version !== "scoped-broker-journal-evidence-v1" || !Buffer.isBuffer(evidence.manifestBytes)
    || !Buffer.isBuffer(evidence.manifestSignature) || evidence.manifestSignature.length !== 64
    || !Buffer.isBuffer(evidence.journalBytes) || !exact(evidence.status, ["actions", "blocked", "ended", "cancelled",
      "journalSha256", "g0Qualified", "verificationAvailable", "inflightVerification"])
    || evidence.status.blocked !== false || evidence.status.ended !== true || evidence.status.cancelled !== false
    || evidence.status.g0Qualified !== false || typeof evidence.status.verificationAvailable !== "boolean"
    || evidence.status.inflightVerification !== null || !Number.isSafeInteger(evidence.status.actions)
    || evidence.status.actions < 0 || evidence.status.actions > 256
    || evidence.status.journalSha256 !== sha(evidence.journalBytes)) throw new Error("scoped-evidence-invalid");
  const authority = createPublicKey(evidence.manifestPublicKey), key = createPublicKey(evidence.journalPublicKey);
  if (authority.asymmetricKeyType !== "ed25519" || !verify(null, evidence.manifestBytes, authority, evidence.manifestSignature))
    throw new Error("scoped-manifest-signature-invalid");
  if (key.asymmetricKeyType !== "ed25519") throw new Error("scoped-journal-key-invalid");
  const authorityDigest = sha(authority.export({ type: "spki", format: "der" }));
  const keyDigest = sha(key.export({ type: "spki", format: "der" })), manifest = validateManifest(evidence.manifestBytes, keyDigest);
  if (manifest.identity.manifestAuthoritySha256 !== authorityDigest || authorityDigest === keyDigest)
    throw new Error("scoped-manifest-authority-mismatch");
  if (evidence.status.verificationAvailable !== (manifest.verifications.length > 0))
    throw new Error("scoped-verification-status-mismatch");
  if (manifest.identity.taskId !== expected.task.taskId || manifest.identity.sessionId !== expected.task.sessionId
    || manifest.identity.requestId !== expected.task.operatorRequestDigest || manifest.identity.operationId !== expected.operationRef
    || expected.messageRequestId !== manifest.identity.nonce
    || expected.plan.identity.configDigest !== (manifest.identity.version === 4
      ? manifest.identity.measurementConfigurationSha256 : manifest.identity.configSha256)
    || expected.plan.identity.armDigest !== scopedBrokerArmDigest(manifest.identity))
    throw new Error("scoped-evidence-binding-mismatch");
  if (!pathSafeRoot(expected.projectRoot) || fs.realpathSync.native(manifest.root) !== fs.realpathSync.native(expected.projectRoot))
    throw new Error("scoped-material-root-mismatch");
  const rows = parseJournal(evidence.journalBytes, key, manifest), actions = validateActions(rows, evidence.status);
  const planBindings = new Map(expected.plan.materialBindings.map((item: any) => [item.id, item]));
  const contractFacts = expected.contract.facts, contextIds = new Set(contractFacts.filter((fact: any) => fact.kind === "context-current")
    .flatMap((fact: any) => fact.parameters.requiredMaterialIds));
  const writableIds = new Set(contractFacts.filter((fact: any) => fact.kind === "workspace-scope")
    .flatMap((fact: any) => fact.parameters.allowedWriteMaterialIds));
  const policy = contractFacts.find((fact: any) => fact.kind === "tool-policy-complete");
  if (!policy || policy.parameters.profileDigest !== scopedBrokerProfileDigest(manifest.profile)) throw new Error("scoped-profile-binding-mismatch");
  if (manifest.materials.length !== expected.plan.materialBindings.length
    || expected.materials.length !== expected.plan.materialBindings.length) throw new Error("scoped-material-set-mismatch");
  const currentMaterials = new Map(expected.materials.map((item: any) => [item.id, item]));
  for (const material of manifest.materials) {
    const binding: any = planBindings.get(material.id);
    if (!binding || binding.relativePath !== material.relativePath || material.readable !== contextIds.has(material.id)
      || material.writable !== writableIds.has(material.id) || material.protected !== (binding.mode === "protected"))
      throw new Error("scoped-material-policy-mismatch");
    const current: any = currentMaterials.get(material.id);
    if (!current || current.relativePath !== material.relativePath || current.mode !== binding.mode)
      throw new Error("scoped-current-material-mismatch");
    if (binding.mode === "frozen" && (binding.sha256 !== material.sha256 || current.sha256 !== material.sha256))
      throw new Error("scoped-frozen-material-mismatch");
    if (binding.mode !== "protected" && sha(readTaskBaselineSource(expected.projectRoot, expected.task, binding.relativePath)) !== material.sha256)
      throw new Error("scoped-baseline-material-mismatch");
    if (binding.mode !== "protected" && !material.writable && current.sha256 !== material.sha256)
      throw new Error("scoped-readonly-material-drift");
  }
  const verifierFacts = contractFacts.filter((fact: any) => fact.kind === "project-verifier-current");
  if (manifest.verifications.length !== verifierFacts.length) throw new Error("scoped-verifier-policy-mismatch");
  const materialMap = currentMaterials;
  const reads = new Map<string, Action[]>(), writes = new Map<string, Action[]>(), verifications = new Map<string, Action[]>();
  const observedDigests = new Map(manifest.materials.map((item: any) => [item.id, item.sha256]));
  const add = (map: Map<string, Action[]>, id: string, action: Action) => map.set(id, [...(map.get(id) ?? []), action]);
  for (const action of actions) {
    if (action.result.outcome !== "observed") continue;
    const read = manifest.materials.filter((item: any) => action.tool === "scoped_read"
      && action.requestSha256 === requestDigest("scoped_read", { materialId: item.id }));
    const write = manifest.materials.filter((item: any) => { const current: any = materialMap.get(item.id);
      return action.tool === "scoped_write_document" && current?.text !== undefined && action.requestSha256 === requestDigest("scoped_write_document",
        { materialId: item.id, expectedSha256: item.sha256, utf8: current.text }); });
    const checks = manifest.verifications.filter((item: any) => action.tool === "scoped_verify"
      && action.requestSha256 === requestDigest("scoped_verify", { verificationId: item.id }));
    if (read.length + write.length + checks.length !== 1) throw new Error("scoped-observed-action-unbound");
    if (read[0]) { if (action.result.materialSha256 !== observedDigests.get(read[0].id)) throw new Error("scoped-read-result-mismatch"); add(reads, read[0].id, action); }
    if (write[0]) { if (action.result.materialSha256 !== materialMap.get(write[0].id)?.sha256) throw new Error("scoped-write-result-mismatch"); add(writes, write[0].id, action); observedDigests.set(write[0].id, action.result.materialSha256); }
    if (checks[0]) add(verifications, checks[0].id, action);
  }
  const snapshot: Snapshot = { manifest, rows, actions, profileDigest: policy.parameters.profileDigest,
    armDigest: scopedBrokerArmDigest(manifest.identity), reads, writes, verifications };
  const capability = Object.freeze({ version: "scoped-mediation-capability-v1", journalSha256: sha(evidence.journalBytes),
    profileDigest: snapshot.profileDigest }); snapshots.set(capability, snapshot); return capability;
}

// A receipt covers only its signed command policy. Dynamic document bytes in
// v3 must still match every writable material and the current workspace.
export function scopedProjectReceiptCoversTask(receipt: any, input: FactInput): boolean {
  const commands = input.task?.verifyCommands;
  if (!Array.isArray(commands) || commands.length === 0 || commands.some(command => typeof command !== "string")) return false;
  if (receipt?.kind !== "scoped-project-verification-receipt-v3")
    return commands.every(command => SCOPED_PROJECT_COMMANDS.has(command.trim()));
  const scope = receipt.scope;
  if (receipt.version !== 3 || receipt.worker?.version !== "scoped-configured-docs-worker-v1"
    || !scope || scope.kind !== "configured-docs-current-v1" || !HASH.test(scope.frozenSourceDigest)
    || !isDeepStrictEqual(commands.map(command => command.trim()), scope.commands)
    || !Array.isArray(scope.files) || scope.files.length < 1 || scope.files.length > 8) return false;
  const paths = new Map(input.plan.materialBindings.map((item: any) => [item.id, item.relativePath]));
  const expectedPaths = [...new Set(input.contract.facts.filter((fact: any) => fact.kind === "workspace-scope")
    .flatMap((fact: any) => fact.parameters.allowedWriteMaterialIds.map((id: string) => paths.get(id))))].sort();
  if (!isDeepStrictEqual(expectedPaths, scope.files.map((item: any) => item.relativePath))) return false;
  if (!input.projectRoot || workingTreeSnapshotHasUnavailableEvidence(input.workspace)) return false;
  try {
    if (!isDeepStrictEqual(workingTreeSnapshot(input.projectRoot), input.workspace)) return false;
    for (const file of scope.files) {
      const material = input.materials.find((item: any) => item.relativePath === file.relativePath);
      if (!HASH.test(file.sha256) || !material || material.sha256 !== file.sha256
        || sha(readWorkspaceFile(input.projectRoot, file.relativePath, 65536)) !== file.sha256
        || typeof material.text !== "string" || Buffer.byteLength(material.text) !== file.byteLength) return false;
    }
    if (!isDeepStrictEqual(workingTreeSnapshot(input.projectRoot), input.workspace)) return false;
  } catch { return false; }
  return receipt.sourceDigest === sha(JSON.stringify({ version: 1, frozenSourceDigest: scope.frozenSourceDigest, files: scope.files }));
}

function disposition(status: "pass" | "fail" | "unknown" | "error", fact: any, details: any,
  reasonCodes: string[], response?: any) {
  const observationDigest = sha(JSON.stringify({ factId: fact.id, details }));
  return { status, observationDigest, counterexampleRef: status === "fail" ? sha(JSON.stringify(details)) : null,
    reasonCodes, ...(response ? { response } : {}) };
}
export function scopedMediationFactObservation(capability: object, input: FactInput) {
  const value = snapshots.get(capability); if (!value) throw new Error("untrusted-scoped-mediation-capability");
  const fact = input.fact, response = input.response;
  if (fact.kind === "tool-policy-complete") {
    const unsafe = value.actions.filter(action => action.result.outcome === "error" || action.result.effectPossible === true);
    return unsafe.length ? disposition("error", fact, unsafe.map(item => item.action), ["capture-error"], response)
      : disposition("pass", fact, { profileDigest: value.profileDigest, actions: value.actions.length }, [], response);
  }
  if (fact.kind === "context-current") {
    const missing = fact.parameters.requiredMaterialIds.filter((id: string) => !value.reads.has(id));
    return missing.length ? disposition("unknown", fact, { missing }, ["incomplete-mediation"], response)
      : disposition("pass", fact, { reads: fact.parameters.requiredMaterialIds }, [], response);
  }
  if (fact.kind === "workspace-scope") {
    const allowed = new Set<string>(fact.parameters.allowedWriteMaterialIds), observed = [...value.writes.keys()];
    const bindings = new Map<string, string>(input.plan.materialBindings.map((item: any) => [item.id, item.relativePath]));
    const allowedPaths = new Set<string | undefined>([...allowed].map(id => bindings.get(id)));
    const baseline: Record<string, string> = input.task.baselineFileDigests ?? {};
    const changed = [...new Set([...Object.keys(baseline), ...Object.keys(input.workspace)])]
      .filter(file => baseline[file] !== input.workspace[file]);
    const violation = observed.some(id => !allowed.has(id)) || changed.some(file => !allowedPaths.has(file));
    if (violation) return disposition("fail", fact, { observed, changed, allowed: [...allowed] }, ["scope-violation"], response);
    // Permission to write does not require a mutation when review found no change.
    // Every actual change still needs an observed write for the same bound path.
    const observedPaths = new Set(observed.map(id => bindings.get(id)));
    const missing = changed.filter(file => !observedPaths.has(file));
    return missing.length ? disposition("unknown", fact, { missing }, ["incomplete-mediation"], response)
      : disposition("pass", fact, { observed, changed }, [], response);
  }
  if (fact.kind === "project-verifier-current") {
    const matches = [...value.verifications.values()].flat().filter(action => action.receipt?.planDigest === fact.parameters.commandSetDigest
      && action.receipt?.protocol === SCOPED_PROJECT_VERIFICATION_PROTOCOL
      && action.receipt?.status === "completed" && action.receipt?.verdict === "observation-recorded"
      && action.receipt?.cleanup?.confirmed === true && action.result.verificationRunId === action.receipt.attemptId);
    if (matches.length !== 1) return disposition("unknown", fact, { matches: matches.length },
      ["incomplete-mediation"], response);
    const receipt = matches[0].receipt;
    if (!scopedProjectReceiptCoversTask(receipt, { ...input, projectRoot: value.manifest.root })) return disposition("unknown", fact,
      { configuredCommandsOrCurrentFilesCovered: false }, ["incomplete-mediation"], response);
    const details = { verificationRunId: receipt.attemptId,
      commandSetDigest: receipt.planDigest, outcome: receipt.evidence?.outcome,
      failedCommands: receipt.evidence?.failedCommands };
    if (receipt.evidence?.outcome === "failed" && Array.isArray(receipt.evidence.failedCommands)
      && receipt.evidence.failedCommands.length > 0) return disposition("fail", fact, details,
      ["verification-failed"], response);
    return receipt.evidence?.outcome === "passed" && Array.isArray(receipt.evidence.failedCommands)
      && receipt.evidence.failedCommands.length === 0 ? disposition("pass", fact, details, [], response)
      : disposition("error", fact, details, ["capture-error"], response);
  }
  throw new Error("unsupported-scoped-mediation-fact");
}
