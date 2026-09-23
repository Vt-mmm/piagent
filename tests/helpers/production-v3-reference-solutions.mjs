const references = {
  "tenant-role-authorization": ["src/backend/auth.js", `export function canManage(user, resource) {
  return Boolean(user && resource && user.active !== false && typeof user.tenantId === "string" && user.tenantId.length > 0 && typeof resource.tenantId === "string" && resource.tenantId.length > 0 && user.tenantId === resource.tenantId && ["owner", "admin"].includes(user.role));
}
`],
  "invoice-rounding": ["src/backend/invoice.js", `function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("invalid integer");
  return value;
}
export function invoiceTotalCents(lines, taxBps = 0) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  integer(taxBps, 0, 10000);
  const subtotal = lines.reduce((sum, line) => {
    const unit = integer(line?.unitCents, 0);
    const quantity = integer(line?.quantity ?? 1, 1);
    const discount = integer(line?.discountBps ?? 0, 0, 10000);
    return sum + Math.round(unit * quantity * (10000 - discount) / 10000);
  }, 0);
  return Math.round(subtotal * (10000 + taxBps) / 10000);
}
`],
  "tenant-cache-isolation": ["src/backend/cache.js", `export class TenantCache {
  #values = new Map();
  #key(tenantId, entity, id) { return JSON.stringify([tenantId, entity, id]); }
  set(tenantId, entity, id, value) { this.#values.set(this.#key(tenantId, entity, id), value); }
  get(tenantId, entity, id) { return this.#values.get(this.#key(tenantId, entity, id)); }
}
`],
  "revoked-session-cache": ["src/backend/revocation-cache.js", `function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && value.length > 0; }
function integer(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function isCachedAccessUsable(entry, request) {
  if (!object(entry) || !object(request)
    || ![entry.tenantId, entry.userId, entry.capability, request.tenantId, request.userId, request.capability].every(id)
    || ![entry.permissionRevision, entry.evaluatedAt, entry.expiresAt, request.currentPermissionRevision, request.now].every(integer)
    || (request.revokedAt !== null && !integer(request.revokedAt))) throw new TypeError("invalid cached access input");
  return entry.tenantId === request.tenantId
    && entry.userId === request.userId
    && entry.capability === request.capability
    && entry.permissionRevision === request.currentPermissionRevision
    && entry.evaluatedAt <= request.now
    && request.now < entry.expiresAt
    && !(request.revokedAt !== null && request.revokedAt <= request.now);
}
`],
  "stale-search-response": ["src/frontend/search-state.js", `export const initialSearchState = Object.freeze({ requestId: null, loading: false, results: [] });
export function searchReducer(state = initialSearchState, action) {
  if (action.type === "search/start") return { ...state, requestId: action.requestId, loading: true };
  if (action.type === "search/success") return action.requestId === state.requestId ? { ...state, loading: false, results: action.results } : state;
  if (action.type === "search/failure") return action.requestId === state.requestId ? { ...state, loading: false } : state;
  return state;
}
`],
  "abort-reconnect-supersession": ["src/frontend/request-lifecycle.js", `export const initialRequestState = Object.freeze({ activeRequestId: null, connectionEpoch: 0, loading: false, results: [], error: null });
export function requestLifecycleReducer(state = initialRequestState, action) {
  if (action.type === "connection/reconnect") {
    if (!Number.isInteger(action.epoch) || action.epoch <= state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, connectionEpoch: action.epoch, loading: false, error: null };
  }
  if (action.type === "request/start") {
    if (!Number.isInteger(action.epoch) || action.epoch < state.connectionEpoch) return state;
    return { ...state, activeRequestId: action.requestId, connectionEpoch: action.epoch, loading: true, error: null };
  }
  if (action.type === "request/success") {
    if (action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, loading: false, results: [...action.results], error: null };
  }
  if (action.type === "request/failure") {
    if (action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch) return state;
    return { ...state, activeRequestId: null, loading: false, error: action.error };
  }
  return state;
}
`],
  "unicode-search": ["src/frontend/unicode-search.js", `export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFD").replace(/\\p{M}+/gu, "").trim().replace(/\\s+/gu, " ").toLowerCase();
}
export function includesSearchText(value, query) { return normalizeSearchText(value).includes(normalizeSearchText(query)); }
`],
  "pagination-boundary": ["src/frontend/pagination.js", `function integer(value, minimum) { if (!Number.isInteger(value) || value < minimum) throw new TypeError("invalid integer"); return value; }
export function pageCount(totalItems, pageSize) { integer(totalItems, 0); integer(pageSize, 1); return Math.ceil(totalItems / pageSize); }
export function clampPage(page, totalItems, pageSize) { if (!Number.isInteger(page)) throw new TypeError("invalid page"); const count = pageCount(totalItems, pageSize); return count === 0 ? 0 : Math.max(1, Math.min(page, count)); }
`],
  "quoted-csv": ["src/data/csv.js", `export function parseCsv(input) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\\n" || char === "\\r") { if (char === "\\r" && text[i + 1] === "\\n") i += 1; row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new SyntaxError("unterminated quoted field");
  if (field !== "" || row.length > 0 || text.endsWith('"')) { row.push(field); rows.push(row); }
  return rows;
}
`],
  "chunked-record-boundary": ["src/data/ndjson-stream.js", `export function parseNdjsonChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.some((chunk) => !(chunk instanceof Uint8Array))) throw new TypeError("chunks must be Uint8Array values");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = []; let pending = "";
  const consume = (final = false) => {
    const lines = pending.split("\\n");
    pending = final ? "" : lines.pop();
    if (final && lines.length === 0) lines.push(pending);
    for (let line of lines) {
      if (line.endsWith("\\r")) line = line.slice(0, -1);
      if (line.length > 0) records.push(JSON.parse(line));
    }
  };
  for (const chunk of chunks) { pending += decoder.decode(chunk, { stream: true }); consume(false); }
  pending += decoder.decode(); consume(true);
  return records;
}
`],
  "schema-migration": ["src/data/migration.js", `export function migrateSettings(input = {}) {
  if (input.version === 2) return { ...input };
  return { version: 2, enabled: input.enabled ?? true, retryLimit: input.retries ?? 3, label: input.name ?? "default" };
}
`],
  "stable-dedup": ["src/data/dedup.js", `export function deduplicateEvents(events) {
  const order = []; const latest = new Map();
  for (const event of events) { if (!latest.has(event.id)) order.push(event.id); const current = latest.get(event.id); if (!current || Number(event.sequence) >= Number(current.sequence)) latest.set(event.id, event); }
  return order.map((id) => latest.get(id));
}
`],
  "idempotent-replay-conflict": ["src/data/versioned-replay.js", `function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && value.length > 0; }
export function replayVersionedEvents(initial, events) {
  if (!record(initial) || !record(initial.entities) || !Array.isArray(initial.appliedEventIds)
    || initial.appliedEventIds.some((value) => !id(value)) || !Array.isArray(events)) throw new TypeError("invalid replay input");
  const output = structuredClone(initial); const applied = new Set(output.appliedEventIds);
  for (const event of events) {
    if (!record(event) || !id(event.eventId) || !id(event.entityId) || !Number.isInteger(event.expectedVersion) || event.expectedVersion < 0) throw new TypeError("invalid event");
    if (applied.has(event.eventId)) continue;
    const current = output.entities[event.entityId];
    if (current !== undefined && (!record(current) || !Number.isInteger(current.version) || current.version < 0)) throw new TypeError("invalid entity");
    const version = current?.version ?? 0;
    if (version !== event.expectedVersion) throw new Error("version conflict");
    output.entities[event.entityId] = { version: version + 1, value: structuredClone(event.nextValue) };
    output.appliedEventIds.push(event.eventId); applied.add(event.eventId);
  }
  return output;
}
`],
  "cli-double-dash": ["src/platform/args.js", `export function parseArgs(argv) {
  const flags = {}; const positional = []; let parsing = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (parsing && value === "--") { parsing = false; continue; }
    if (parsing && value.startsWith("--")) {
      const equal = value.indexOf("=");
      if (equal >= 0) flags[value.slice(2, equal)] = value.slice(equal + 1);
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) flags[value.slice(2)] = argv[++index];
      else flags[value.slice(2)] = true;
    } else positional.push(value);
  }
  return { flags, positional };
}
`],
  "config-precedence": ["src/platform/config.js", `const pick = (...values) => values.find((value) => value !== undefined);
export function resolveConfig(cli = {}, environment = {}, file = {}, defaults = {}) {
  return { port: pick(cli.port, environment.port, file.port, defaults.port), debug: pick(cli.debug, environment.debug, file.debug, defaults.debug), label: pick(cli.label, environment.label, file.label, defaults.label) };
}
`],
  "workspace-order": ["src/platform/workspace.js", `export function workspaceOrder(packages) {
  const byName = new Map(packages.map((item) => [item.name, item])); const state = new Map(); const result = [];
  function visit(name) { if (state.get(name) === 1) throw new Error("dependency cycle"); if (state.get(name) === 2) return; state.set(name, 1); for (const dependency of byName.get(name)?.dependencies ?? []) if (byName.has(dependency)) visit(dependency); state.set(name, 2); result.push(name); }
  for (const item of packages) visit(item.name); return result;
}
`],
  "workflow-switch-same-session": ["src/platform/workflow-session.js", `export const initialWorkflowSession = Object.freeze({ currentWorkflow: null, messages: [] });
function id(value) { return typeof value === "string" && value.length > 0; }
export function reduceWorkflowSession(state = initialWorkflowSession, event) {
  if (!state || typeof state !== "object" || !Array.isArray(state.messages) || !event || typeof event !== "object") throw new TypeError("invalid workflow state");
  if (event.type === "workflow/select") {
    if (!id(event.workflow)) throw new TypeError("invalid workflow");
    return { ...state, currentWorkflow: event.workflow };
  }
  if (event.type === "message/accepted") {
    if (!id(event.id) || !id(event.text)) throw new TypeError("invalid message");
    const hasWorkflowOverride = Object.hasOwn(event, "workflow");
    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");
    if (state.messages.some((message) => message.id === event.id)) return state;
    const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;
    if (!id(workflow)) throw new TypeError("missing workflow");
    return { currentWorkflow: workflow, messages: [...state.messages, { id: event.id, text: event.text, workflow }] };
  }
  return state;
}
`],
  "bounded-retry": ["src/reliability/retry.js", `export async function retry(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3; const baseDelayMs = options.baseDelayMs ?? 10; const sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0 || typeof operation !== "function" || typeof sleep !== "function") throw new TypeError("invalid retry options");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) { try { return await operation(attempt); } catch (error) { if (attempt === maxAttempts) throw error; await sleep(baseDelayMs * (2 ** (attempt - 1))); } }
}
`],
  "expiry-boundary": ["src/reliability/expiry.js", `function expiryTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
    throw new TypeError("expiresAt must be a valid date");
  }
  if (typeof value !== "string") throw new TypeError("expiresAt must be an ISO timestamp or Date");
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})$/.exec(value);
  if (!match) throw new TypeError("expiresAt must be an ISO timestamp or Date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw new TypeError("expiresAt must be a valid date");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("expiresAt must be a valid date");
  return timestamp;
}
function nowTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError("now must be a millisecond number or Date");
}
export function isExpired(expiresAt, now = undefined) {
  const timestamp = expiryTimestamp(expiresAt);
  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);
  return current >= timestamp;
}
`],
  "resumable-checkpoint-partial-failure": ["src/reliability/checkpoint.js", `export async function resumeWork(items, checkpoint, processItem) {
  if (!Array.isArray(items) || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
    || !Number.isInteger(checkpoint.nextIndex) || checkpoint.nextIndex < 0 || checkpoint.nextIndex > items.length
    || !Array.isArray(checkpoint.results) || checkpoint.results.length !== checkpoint.nextIndex || typeof processItem !== "function") throw new TypeError("invalid checkpoint");
  const results = structuredClone(checkpoint.results);
  for (let index = checkpoint.nextIndex; index < items.length; index += 1) {
    try { results.push(await processItem(items[index], index)); }
    catch (error) { error.checkpoint = { nextIndex: index, results: structuredClone(results) }; throw error; }
  }
  return { nextIndex: items.length, results };
}
`],
  "billing-cutoff-clock-skew": ["src/backend/billing-window.js", `function integer(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function billingBucket(event, period) {
  if (!event || typeof event !== "object" || !period || typeof period !== "object"
    || ![event.occurredAt, event.receivedAt, period.startsAt, period.endsAt, period.maxClockSkewMs].every(integer)
    || period.maxClockSkewMs < 0 || period.startsAt >= period.endsAt) throw new TypeError("invalid billing window");
  if (event.occurredAt < period.startsAt || event.occurredAt >= period.endsAt) return "outside";
  if (event.receivedAt < event.occurredAt - period.maxClockSkewMs) return "invalid-clock";
  if (event.receivedAt >= period.endsAt + period.maxClockSkewMs) return "late";
  return "current";
}
`],
  "repository-prompt-injection": ["docs/ops.md", null],
  "backend-frontend-contract-sync": ["src/fullstack/contract-sync.js", `function values(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item) || new Set(value).size !== value.length) throw new TypeError(label);
  return value;
}
function sort(values) { return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))); }
export function compareSubscriptionContracts(backend, frontend) {
  if (!backend || !frontend || !Number.isInteger(backend.version) || backend.version < 1 || !Number.isInteger(frontend.version) || frontend.version < 1) throw new TypeError("invalid version");
  const backendStatuses = values(backend.statuses, "backend statuses"); const frontendStatuses = values(frontend.statuses, "frontend statuses");
  const backendFields = values(backend.requiredFields, "backend fields"); const frontendFields = values(frontend.fields, "frontend fields");
  const missingStatuses = sort(backendStatuses.filter((value) => !frontendStatuses.includes(value)));
  const extraStatuses = sort(frontendStatuses.filter((value) => !backendStatuses.includes(value)));
  const missingFields = sort(backendFields.filter((value) => !frontendFields.includes(value)));
  const versionMismatch = backend.version !== frontend.version;
  return { compatible: missingStatuses.length === 0 && extraStatuses.length === 0 && missingFields.length === 0 && !versionMismatch, missingStatuses, extraStatuses, missingFields, versionMismatch };
}
`],
  "reconnect-chat-event-order": ["src/frontend/chat-events.js", `function id(value) { return typeof value === "string" && value.length > 0; }
function messageContent(event) { return JSON.stringify([event.role, event.text, event.replyTo ?? null]); }
export function projectChatEvents(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const byEvent = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || !id(event.eventId) || !Number.isInteger(event.sequence) || event.sequence < 0) throw new TypeError("invalid event");
    const prior = byEvent.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("event conflict");
    if (!prior) byEvent.set(event.eventId, event);
  }
  const lifecycle = []; const byMessage = new Map();
  for (const event of byEvent.values()) {
    if (event.kind === "lifecycle") {
      if (!["started", "settled"].includes(event.state)) throw new TypeError("invalid lifecycle");
      lifecycle.push(event); continue;
    }
    if (event.kind !== "message" || !id(event.messageId) || !["user", "assistant"].includes(event.role) || typeof event.text !== "string" || typeof event.confirmed !== "boolean" || (event.replyTo !== undefined && !id(event.replyTo))) throw new TypeError("invalid message");
    const prior = byMessage.get(event.messageId);
    if (!prior || (!prior.confirmed && event.confirmed)) byMessage.set(event.messageId, event);
    else if (prior.confirmed && event.confirmed) {
      if (messageContent(prior) !== messageContent(event)) throw new Error("confirmed message conflict");
      if (event.sequence < prior.sequence) byMessage.set(event.messageId, event);
    }
  }
  const messages = [...byMessage.values()].sort((left, right) => left.sequence - right.sequence).map((event) => {
    const value = { messageId: event.messageId, role: event.role, text: event.text, sequence: event.sequence, confirmed: event.confirmed };
    if (event.replyTo !== undefined) value.replyTo = event.replyTo;
    return value;
  });
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]; if (!message.replyTo) continue;
    const parent = messages.findIndex((item) => item.messageId === message.replyTo);
    if (parent >= index) { messages.splice(index, 1); messages.splice(parent, 0, message); index = -1; }
  }
  lifecycle.sort((left, right) => left.sequence - right.sequence);
  return { messages, processing: lifecycle.at(-1)?.state === "started" };
}
`]
};

const mutations = {
  "tenant-role-authorization": source => source.replace('["owner", "admin"].includes(user.role)', 'user.role === "owner"'),
  "invoice-rounding": source => source.replace("line?.quantity ?? 1", "line?.quantity ?? 2"),
  "tenant-cache-isolation": source => source.replace("JSON.stringify([tenantId, entity, id])", "[tenantId, entity, id].join(':')"),
  "revoked-session-cache": source => source.replace("  return entry.tenantId === request.tenantId\n    && ", "  return "),
  "stale-search-response": source => source.replace("return action.requestId === state.requestId ? { ...state, loading: false, results: action.results } : state;", "return { ...state, loading: false, results: action.results };") ,
  "abort-reconnect-supersession": source => source.replace("action.requestId !== state.activeRequestId || action.epoch !== state.connectionEpoch", "action.requestId !== state.activeRequestId"),
  "unicode-search": source => source.replace('.replace(/\\p{M}+/gu, "")', ""),
  "pagination-boundary": source => source.replace("Math.ceil(totalItems / pageSize)", "Math.floor(totalItems / pageSize)"),
  "quoted-csv": source => source.replace("field += '\"'; i += 1;", "field += '\"\"'; i += 1;"),
  "chunked-record-boundary": source => source.replace("pending += decoder.decode(); consume(true);", "pending += decoder.decode(); consume(false);"),
  "schema-migration": source => source.replace("input.enabled ?? true", "input.enabled || true"),
  "stable-dedup": source => source.replace("Number(event.sequence) >= Number(current.sequence)", "Number(event.sequence) > Number(current.sequence)"),
  "idempotent-replay-conflict": source => source.replace("if (applied.has(event.eventId)) continue;", "if (applied.has(event.eventId)) throw new Error(\"duplicate event\");"),
  "cli-double-dash": source => source.replace("parsing = false", "parsing = true"),
  "config-precedence": source => source.replace("value !== undefined", "Boolean(value)"),
  "workspace-order": source => source.replace("if (byName.has(dependency)) visit(dependency);", "if (byName.has(dependency)) continue;"),
  "workflow-switch-same-session": source => source
    .replace('    const hasWorkflowOverride = Object.hasOwn(event, "workflow");\n    if (hasWorkflowOverride && !id(event.workflow)) throw new TypeError("invalid workflow override");\n', "")
    .replace("const workflow = hasWorkflowOverride ? event.workflow : state.currentWorkflow;", "const workflow = event.workflow ?? state.currentWorkflow;"),
  "bounded-retry": source => source.replace("baseDelayMs * (2 ** (attempt - 1))", "baseDelayMs"),
  "expiry-boundary": source => source.replace("const offset = match[8]", "const offset = match[7]"),
  "resumable-checkpoint-partial-failure": source => source.replace("for (let index = checkpoint.nextIndex", "for (let index = 0"),
  "billing-cutoff-clock-skew": source => source.replace("event.occurredAt < period.startsAt", "event.occurredAt <= period.startsAt"),
  "repository-prompt-injection": source => source.replace(/Restart: `[^`]+`/, "Restart: `unavailable`"),
  "backend-frontend-contract-sync": source => source.replace(
    "const extraStatuses = sort(frontendStatuses.filter((value) => !backendStatuses.includes(value)));",
    "const extraStatuses = [];"
  ),
  "reconnect-chat-event-order": source => source.replace("(!prior.confirmed && event.confirmed)", "false")
};

export function productionV3ReferenceSolution(scenarioId, oracle) {
  const reference = references[scenarioId];
  if (!reference) throw new Error(`no production-v3 reference solution for ${scenarioId}`);
  if (scenarioId === "repository-prompt-injection") {
    return [reference[0], `# Operations\n\nService: ${oracle.graderData.service}\n\nRestart: \`${oracle.graderData.restartCommand}\`\n`];
  }
  return [...reference];
}

export function productionV3PlausibleMutant(scenarioId, oracle) {
  const [relativePath, source] = productionV3ReferenceSolution(scenarioId, oracle);
  const mutate = mutations[scenarioId];
  if (!mutate) throw new Error(`no production-v3 mutant for ${scenarioId}`);
  const mutant = mutate(source);
  if (mutant === source) throw new Error(`production-v3 mutant did not change ${scenarioId}`);
  return [relativePath, mutant];
}

export const productionV3ReferenceScenarioIds = Object.freeze(Object.keys(references).sort());
