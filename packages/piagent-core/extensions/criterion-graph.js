import crypto from "node:crypto";

export const CRITERION_GRAPH_SCHEMA_VERSION = 1;
export const CRITERION_GRAPH_COMPILER = "criterion-graph-v1";
export const CRITERION_GRAPH_MODES = Object.freeze(["mechanical", "criterion-graph"]);
export const CRITERION_GRAPH_KINDS = Object.freeze(["behavior", "boundary", "output", "scope", "verification", "investigation"]);
export const CRITERION_GRAPH_PROOF_KINDS = Object.freeze(["behavioral-check", "exact-verifier", "read-evidence", "scoped-diff"]);

const GRAPH_FIELDS = new Set(["schemaVersion", "compiler", "mode", "criterionDigest", "graphDigest", "createdAt", "nodes", "order"]);
const NODE_FIELDS = new Set(["id", "criterionIndex", "obligation", "kind", "proofKinds", "targetHints", "dependsOn"]);

function uniqueStrings(values, maximum = 12) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().replaceAll("\\", "/")))].slice(0, maximum);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(domain, value) {
  return crypto.createHash("sha256").update(`${domain}\0${stableJson(value)}`).digest("hex");
}

function criterionContract(input) {
  return {
    acceptanceCriteria: uniqueStrings(input.acceptanceCriteria),
    scope: uniqueStrings(input.scope, 2000),
    verifyCommands: uniqueStrings(input.verifyCommands),
    changeMode: input.changeMode === "read-only" ? "read-only" : "source-change"
  };
}

const VERIFICATION_NAMED_TARGET = String.raw`(?:verification(?:\s+commands?)?|verifiers?)`;
const VERIFICATION_TEST_TARGET = String.raw`tests?`;
const VERIFICATION_COMMAND_TARGET = String.raw`(?:typechecks?|lint|build)`;
const COMMAND_LIKE_TEST_PREFIX = String.raw`(?:npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|cargo|go|make|gradle|mvn|dotnet|bash|sh|jest|vitest|mocha|ava|tap|playwright|no)`;
const VERIFICATION_DESCRIPTION = String.raw`(?:(?!(?:and|then)\b)[a-z0-9_./:+-]+\s+){0,5}`;
const VERIFICATION_TEST_DESCRIPTION = String.raw`(?:(?!(?:and|then|${COMMAND_LIKE_TEST_PREFIX})\b)[a-z0-9_./:+-]+\s+){0,5}`;
const VERIFICATION_CONTEXT = String.raw`(?:\s+(?:after\s+(?:the\s+)?(?:final\s+)?(?:intended\s+)?(?:implementation|mutation)|(?:on|against)\s+(?:the\s+)?(?:current|final)\s+(?:tree|workspace)))?`;
const VERIFICATION_TEST_SUBJECT = String.raw`(?:(?:the|an?|all|each|every)\s+)?(?:${VERIFICATION_DESCRIPTION}${VERIFICATION_NAMED_TARGET}|${VERIFICATION_TEST_DESCRIPTION}${VERIFICATION_TEST_TARGET})`;
const VERIFICATION_COMMAND_SUBJECT = String.raw`(?:the\s+)?(?:(?:configured|exact|focused|project|workspace)\s+)?${VERIFICATION_COMMAND_TARGET}`;
const VERIFICATION_SUBJECT = String.raw`(?:only\s+)?(?:${VERIFICATION_TEST_SUBJECT}|${VERIFICATION_COMMAND_SUBJECT})`;
const VERIFICATION_MODAL = String.raw`(?:(?:must|should|shall)\s+)?`;
const VERIFICATION_IMPERATIVE = String.raw`${VERIFICATION_MODAL}(?:run|execute|rerun|re-run)\s+${VERIFICATION_SUBJECT}${VERIFICATION_CONTEXT}`;
const VERIFICATION_DECLARATION = String.raw`${VERIFICATION_SUBJECT}\s+${VERIFICATION_MODAL}(?:pass(?:es)?|run(?:s)?)${VERIFICATION_CONTEXT}`;
const FULL_VERIFICATION_CLAUSE = new RegExp(`^(?:${VERIFICATION_IMPERATIVE}|${VERIFICATION_DECLARATION})[.!?]?\\s*$`, "i");
const TERMINAL_VERIFICATION_CLAUSE = new RegExp(`(?:[,;.]\\s*|\\s+(?:and|then)\\s+)(?:${VERIFICATION_IMPERATIVE}|${VERIFICATION_DECLARATION})[.!?]?\\s*$`, "i");
const BACKTICKED_COMMAND = String.raw`\x60([^\x60\r\n]+)\x60`;
const EXACT_COMMAND_IMPERATIVE = String.raw`${VERIFICATION_MODAL}(?:run|execute|rerun|re-run)\s+${BACKTICKED_COMMAND}${VERIFICATION_CONTEXT}`;
const EXACT_COMMAND_DECLARATION = String.raw`${BACKTICKED_COMMAND}\s+${VERIFICATION_MODAL}(?:pass(?:es)?|run(?:s)?)${VERIFICATION_CONTEXT}`;
const BARE_COMMAND_IMPERATIVE = String.raw`${VERIFICATION_MODAL}(?:run|execute|rerun|re-run)\s+([^\r\n]+?)`;
const BARE_COMMAND_DECLARATION = String.raw`([^\r\n]+?)\s+${VERIFICATION_MODAL}(?:pass(?:es)?|run(?:s)?)${VERIFICATION_CONTEXT}`;
const FULL_EXACT_COMMAND_CLAUSES = [EXACT_COMMAND_IMPERATIVE, EXACT_COMMAND_DECLARATION, BARE_COMMAND_IMPERATIVE, BARE_COMMAND_DECLARATION]
  .map((source) => new RegExp(`^(?:${source})[.!?]?\\s*$`, "i"));
const TERMINAL_EXACT_COMMAND_CLAUSES = [EXACT_COMMAND_IMPERATIVE, EXACT_COMMAND_DECLARATION, BARE_COMMAND_IMPERATIVE, BARE_COMMAND_DECLARATION]
  .map((source) => new RegExp(`(?:[,;.]\\s*|\\s+(?:and|then)\\s+)(?:${source})[.!?]?\\s*$`, "i"));

function normalizedVerifierCommand(command) {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

function exactConfiguredCommandMatch(text, patterns, verifyCommands) {
  const configured = new Set(uniqueStrings(verifyCommands).map(normalizedVerifierCommand));
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const command = normalizedVerifierCommand(match?.[1]);
    if (match && !/^no\s+tests?\b/i.test(command) && configured.has(command)) return match;
  }
  return undefined;
}

function withoutTerminalVerificationClause(obligation, verifyCommands) {
  const text = obligation.replace(/^\s*\[[a-z][a-z0-9_-]{0,20}\]\s*/i, "").trim();
  const terminal = text.match(TERMINAL_VERIFICATION_CLAUSE)
    ?? exactConfiguredCommandMatch(text, TERMINAL_EXACT_COMMAND_CLAUSES, verifyCommands);
  if (terminal && terminal.index !== undefined) {
    return { text: text.slice(0, terminal.index).replace(/[,;.]\s*$/, "").trim(), verification: true };
  }
  const verificationOnly = FULL_VERIFICATION_CLAUSE.test(text)
    || Boolean(exactConfiguredCommandMatch(text, FULL_EXACT_COMMAND_CLAUSES, verifyCommands));
  return verificationOnly ? { text: "", verification: true } : { text, verification: false };
}

function kindFor(obligation, changeMode, verifyCommands) {
  if (changeMode === "read-only") return "investigation";
  const terminal = withoutTerminalVerificationClause(obligation, verifyCommands);
  if (!terminal.text && terminal.verification) return "verification";
  const text = terminal.text.toLowerCase();
  if (/\b(scope|out[- ]of[- ]scope|unrelated files?|only (?:touch|change|modify)|changed files?)\b/.test(text)) return "scope";
  if (/\b(invalid|malformed|reject|throw|error|failure|negative|fractional|null|undefined|empty input)\b/.test(text)) return "boundary";
  if (/\b(output|return|render|format|serialize|response|result)\b/.test(text)) return "output";
  return "behavior";
}

function proofKindsFor(kind, changeMode) {
  if (changeMode === "read-only") return ["read-evidence"];
  if (kind === "scope") return ["scoped-diff", "exact-verifier"];
  if (kind === "verification") return ["exact-verifier"];
  return ["behavioral-check", "exact-verifier"];
}

function targetHintsFor(obligation, scope, mode) {
  if (mode !== "criterion-graph") return [];
  const text = obligation.toLowerCase();
  const matched = scope.filter((candidate) => {
    const normalized = candidate.toLowerCase();
    const basename = normalized.split("/").pop()?.replace(/[?*{}[\]]/g, "") ?? "";
    const stem = basename.replace(/\.[a-z0-9]+$/i, "");
    return text.includes(normalized) || (basename.length >= 3 && text.includes(basename)) || (stem.length >= 4 && text.includes(stem));
  });
  return (matched.length > 0 ? matched : scope).slice(0, 4);
}

function criterionLabel(obligation) {
  return obligation.match(/^\s*\[([A-Za-z][A-Za-z0-9_-]{0,20})\]/)?.[1]?.toLowerCase();
}

function explicitDependencyLabels(obligation) {
  const dependencies = [];
  const pattern = /\b(?:depends?\s+on|after)\s+\[?([A-Za-z][A-Za-z0-9_-]{0,20})\]?/gi;
  for (const match of obligation.matchAll(pattern)) dependencies.push(match[1].toLowerCase());
  return [...new Set(dependencies)];
}

function graphBody(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    compiler: graph.compiler,
    mode: graph.mode,
    criterionDigest: graph.criterionDigest,
    nodes: graph.nodes,
    order: graph.order
  };
}

export function criterionGraphMode(value = process.env.PIAGENT_INTELLIGENCE_ENGINE) {
  return /^(?:0|off|false|mechanical)$/i.test(String(value ?? "")) ? "mechanical" : "criterion-graph";
}

export function compileCriterionGraph(input) {
  const contract = criterionContract(input);
  const mode = CRITERION_GRAPH_MODES.includes(input.mode) ? input.mode : criterionGraphMode(input.mode);
  const labels = new Map();
  contract.acceptanceCriteria.forEach((criterion, index) => {
    const label = criterionLabel(criterion);
    if (label && !labels.has(label)) labels.set(label, `criterion-${String(index + 1).padStart(2, "0")}`);
  });
  const nodes = contract.acceptanceCriteria.map((obligation, criterionIndex) => {
    const id = `criterion-${String(criterionIndex + 1).padStart(2, "0")}`;
    const kind = kindFor(obligation, contract.changeMode, contract.verifyCommands);
    const explicit = explicitDependencyLabels(obligation).map((label) => labels.get(label)).filter((dependency) => (
      dependency && Number(dependency.slice(-2)) - 1 < criterionIndex
    ));
    const verificationDependencies = kind === "verification"
      ? contract.acceptanceCriteria.slice(0, criterionIndex).map((_, index) => `criterion-${String(index + 1).padStart(2, "0")}`)
      : [];
    return {
      id,
      criterionIndex,
      obligation,
      kind,
      proofKinds: proofKindsFor(kind, contract.changeMode),
      targetHints: targetHintsFor(obligation, contract.scope, mode),
      dependsOn: [...new Set([...explicit, ...verificationDependencies])].filter((dependency) => dependency !== id)
    };
  });
  const graph = {
    schemaVersion: CRITERION_GRAPH_SCHEMA_VERSION,
    compiler: CRITERION_GRAPH_COMPILER,
    mode,
    criterionDigest: hash("criterion-contract-v1", contract),
    createdAt: input.createdAt,
    nodes,
    order: nodes.map((node) => node.id)
  };
  return { ...graph, graphDigest: hash("criterion-graph-v1", graphBody(graph)) };
}

export function normalizeCriterionGraph(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nodes = Array.isArray(value.nodes) ? value.nodes.map((node) => ({
    id: node?.id,
    criterionIndex: node?.criterionIndex,
    obligation: node?.obligation,
    kind: node?.kind,
    proofKinds: uniqueStrings(node?.proofKinds),
    targetHints: uniqueStrings(node?.targetHints),
    dependsOn: uniqueStrings(node?.dependsOn)
  })) : [];
  return {
    schemaVersion: value.schemaVersion,
    compiler: value.compiler,
    mode: value.mode,
    criterionDigest: value.criterionDigest,
    graphDigest: value.graphDigest,
    createdAt: value.createdAt,
    nodes,
    order: uniqueStrings(value.order)
  };
}

export function criterionGraphValidationErrors(value, task) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["criterionGraph must be an object"];
  const errors = [];
  const unsupported = Object.keys(value).find((key) => !GRAPH_FIELDS.has(key));
  if (unsupported) errors.push(`criterionGraph contains unsupported field ${unsupported}`);
  if (value.schemaVersion !== CRITERION_GRAPH_SCHEMA_VERSION) errors.push(`criterionGraph schemaVersion must be ${CRITERION_GRAPH_SCHEMA_VERSION}`);
  if (value.compiler !== CRITERION_GRAPH_COMPILER) errors.push(`criterionGraph compiler must be ${CRITERION_GRAPH_COMPILER}`);
  if (!CRITERION_GRAPH_MODES.includes(value.mode)) errors.push("criterionGraph mode is invalid");
  if (!/^([a-f0-9]{64})$/.test(value.criterionDigest ?? "")) errors.push("criterionGraph criterionDigest is invalid");
  if (!/^([a-f0-9]{64})$/.test(value.graphDigest ?? "")) errors.push("criterionGraph graphDigest is invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) errors.push("criterionGraph createdAt is invalid");
  if (!Array.isArray(value.nodes)) errors.push("criterionGraph nodes must be an array");
  if (!Array.isArray(value.order)) errors.push("criterionGraph order must be an array");
  const criteria = uniqueStrings(task?.acceptanceCriteria);
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (nodes.length !== criteria.length) errors.push("criterionGraph must map every acceptance criterion exactly once");
  const ids = new Set();
  const indices = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      errors.push("criterionGraph node is invalid");
      continue;
    }
    const extra = Object.keys(node).find((key) => !NODE_FIELDS.has(key));
    if (extra) errors.push(`criterionGraph node contains unsupported field ${extra}`);
    if (!/^criterion-[0-9]{2}$/.test(node.id ?? "") || ids.has(node.id)) errors.push("criterionGraph node ids must be unique canonical ids");
    ids.add(node.id);
    if (!Number.isInteger(node.criterionIndex) || node.criterionIndex < 0 || node.criterionIndex >= criteria.length || indices.has(node.criterionIndex)) errors.push("criterionGraph criterionIndex must be unique and in range");
    indices.add(node.criterionIndex);
    if (criteria[node.criterionIndex] !== node.obligation) errors.push("criterionGraph obligation must equal its Task Contract criterion");
    if (!CRITERION_GRAPH_KINDS.includes(node.kind)) errors.push("criterionGraph node kind is invalid");
    if (!Array.isArray(node.proofKinds) || node.proofKinds.length === 0 || node.proofKinds.some((kind) => !CRITERION_GRAPH_PROOF_KINDS.includes(kind))) errors.push("criterionGraph proofKinds are invalid");
    for (const field of ["targetHints", "dependsOn"]) {
      if (!Array.isArray(node[field]) || node[field].some((item) => typeof item !== "string" || !item.trim())) errors.push(`criterionGraph ${field} must contain strings`);
    }
  }
  if (nodes.some((node) => (node?.dependsOn ?? []).some((dependency) => !ids.has(dependency) || dependency === node.id))) errors.push("criterionGraph dependencies must reference another node");
  if (nodes.some((node) => (node?.targetHints ?? []).some((hint) => !uniqueStrings(task?.scope, 2000).includes(hint)))) errors.push("criterionGraph targetHints must come from Task Contract scope");
  if (JSON.stringify(value.order) !== JSON.stringify(nodes.map((node) => node.id))) errors.push("criterionGraph order must equal canonical node order");
  if (nodes.some((node, index) => (node?.dependsOn ?? []).some((dependency) => value.order?.indexOf(dependency) >= index))) errors.push("criterionGraph dependencies must precede their dependent node");
  const expected = compileCriterionGraph({
    acceptanceCriteria: task?.acceptanceCriteria,
    scope: task?.scope,
    verifyCommands: task?.verifyCommands,
    changeMode: task?.changeMode,
    mode: value.mode,
    createdAt: value.createdAt
  });
  if (value.criterionDigest !== expected.criterionDigest) errors.push("criterionGraph is not bound to the current Task Contract criteria");
  if (value.graphDigest !== hash("criterion-graph-v1", graphBody(value))) errors.push("criterionGraph graphDigest is invalid");
  return [...new Set(errors)];
}

export function criterionGraphGuidance(graph, maximumLines = 12) {
  if (!graph || graph.mode !== "criterion-graph") return [];
  return graph.nodes.slice(0, maximumLines).map((node) => {
    const visibleTargets = node.targetHints.slice(0, 2);
    const targets = visibleTargets.length > 0
      ? ` @${visibleTargets.join(",")}${node.targetHints.length > visibleTargets.length ? `+${node.targetHints.length - visibleTargets.length}` : ""}`
      : "";
    const localProof = node.proofKinds.filter((kind) => kind !== "exact-verifier");
    const proof = localProof.length > 0 ? ` proof=${localProof.join("+")}` : "";
    const dependencies = node.dependsOn.length > 3
      ? ` after=${node.dependsOn.length}-prior`
      : node.dependsOn.length > 0 ? ` after=${node.dependsOn.join(",")}` : "";
    return `${node.id} ${node.kind}${targets}${proof}${dependencies}`;
  });
}

function projectRelative(value) {
  return typeof value === "string" && value.trim() && !value.startsWith("/") && !value.split("/").includes("..");
}

function scopePatternMatches(pattern, file) {
  if (pattern === file) return true;
  const directory = pattern.replace(/\/+$/, "");
  if (directory && !/[*?{}[\]]/.test(directory) && file.startsWith(`${directory}/`)) return true;
  const escaped = pattern.replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
  try { return new RegExp(`^${escaped}$`).test(file); } catch { return false; }
}

export function criterionGraphContextSelectionDetails(graph, projectFiles, observedContext = [], maximum = 8, inputComplete = true, taskScope = []) {
  const limit = Number.isInteger(maximum) ? Math.max(0, Math.min(50, maximum)) : 8;
  const availableFiles = uniqueStrings(projectFiles, 20_001).filter(projectRelative);
  const files = availableFiles.slice(0, 20_000);
  const selected = [];
  if (graph?.mode === "criterion-graph") {
    for (const node of graph.nodes ?? []) {
      for (const hint of node.targetHints ?? []) {
        for (const file of files.filter((candidate) => scopePatternMatches(hint, candidate))) {
          selected.push({ path: file, reason: `${node.id} ${node.kind} target` });
        }
      }
    }
  }
  selected.push(...(Array.isArray(observedContext) ? observedContext : []));
  const seen = new Set();
  const candidates = selected.filter((entry) => {
    if (!entry || typeof entry.path !== "string" || !entry.path.trim() || typeof entry.reason !== "string" || !entry.reason.trim() || seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  }).map((entry) => ({ path: entry.path.trim().replaceAll("\\", "/"), reason: entry.reason.trim() }));
  const selectedPaths = new Set(candidates.map((entry) => entry.path));
  const scopeInput = uniqueStrings(taskScope, 2001), scopePatterns = scopeInput.slice(0, 2000);
  const scopeSyntaxComplete = scopePatterns.every((pattern) => !/[{}[\]]/.test(pattern));
  const scopeCovered = scopePatterns.length === 0 || files
    .filter((file) => scopePatterns.some((pattern) => scopePatternMatches(pattern, file)))
    .every((file) => selectedPaths.has(file));
  return {
    entries: candidates.slice(0, limit),
    candidateCount: candidates.length,
    complete: inputComplete === true && scopeInput.length <= 2000 && scopeSyntaxComplete && availableFiles.length <= 20_000 && candidates.length <= limit && scopeCovered
  };
}

export function criterionGraphContextSelection(graph, projectFiles, observedContext = [], maximum = 8, inputComplete = true, taskScope = []) {
  return criterionGraphContextSelectionDetails(graph, projectFiles, observedContext, maximum, inputComplete, taskScope).entries;
}
