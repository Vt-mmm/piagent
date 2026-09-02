import { createHash, createHmac, KeyObject, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const EVIDENCE_STORE_VERSION = "authenticated-contract-events-v1";
export const FACT_EVIDENCE_SCOPE_VERSION = "authenticated-contract-fact-scope-v2";
export const ROOT_AGGREGATE_FACT_ID = "root-aggregate";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const FACT_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const BINDINGS = ["criterionHash", "snapshotDigest", "verifierDigest", "projectVerificationDigest", "planDigest", "backendDigest"];
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const hostStores = new WeakSet();
export const isAcceptanceEvidenceStore = (store) => Boolean(store && hostStores.has(store));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const frozenCopy = (value) => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozenCopy(child); Object.freeze(value); }
  return value;
};

function exactRecord(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Invalid evidence store record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some((field) => !descriptors[field] || !("value" in descriptors[field]))) {
    throw new TypeError("Invalid evidence store fields");
  }
  return value;
}

function identity(scope) {
  const version = scope && typeof scope === "object" ? Object.getOwnPropertyDescriptor(scope, "version")?.value : undefined;
  if (version === FACT_EVIDENCE_SCOPE_VERSION) {
    exactRecord(scope, ["version", "taskRunId", "criterionId", "factId"]);
    if (typeof scope.taskRunId !== "string" || !ID.test(scope.taskRunId)
      || typeof scope.criterionId !== "string" || !ID.test(scope.criterionId)
      || typeof scope.factId !== "string" || !FACT_ID.test(scope.factId)) throw new TypeError("Invalid fact evidence scope");
    return { version, taskRunId: scope.taskRunId, criterionId: scope.criterionId, factId: scope.factId };
  }
  exactRecord(scope, ["taskRunId", "criterionId"]);
  if (typeof scope.taskRunId !== "string" || !ID.test(scope.taskRunId)
    || typeof scope.criterionId !== "string" || !ID.test(scope.criterionId)) throw new TypeError("Invalid evidence scope");
  return { taskRunId: scope.taskRunId, criterionId: scope.criterionId };
}

function bindingSnapshot(binding) {
  exactRecord(binding, BINDINGS);
  if (BINDINGS.some((field) => typeof binding[field] !== "string" || !HASH.test(binding[field]))) throw new TypeError("Invalid evidence binding");
  return Object.fromEntries(BINDINGS.map((field) => [field, binding[field]]));
}

function evidenceText(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_EVIDENCE_BYTES) throw new TypeError("Invalid evidence payload size");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Invalid evidence payload");
  return JSON.stringify(parsed);
}

function privateStateFile(filePath, projectRoot) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")
    || typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
    || !Number.isInteger(fs.constants.O_NOFOLLOW) || typeof process.getuid !== "function") throw new TypeError("Private evidence storage unavailable");
  const root = fs.realpathSync.native(projectRoot);
  const directory = path.dirname(filePath);
  if (fs.realpathSync.native(directory) !== directory || path.resolve(filePath) !== filePath) throw new Error("Evidence directory must be canonical and not symlinked");
  const relative = path.relative(root, filePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Evidence storage must be outside the candidate project");
  }
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("Evidence directory must be private and host-owned");
  let created = false;
  try {
    const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    created = true;
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Evidence file must be private, regular, and unlinked");
  // SQLite opens its own descriptor. The parent directory and the same-user
  // host are trusted; these checks do not claim to defeat an active host race.
  return { root, created, dev: stat.dev, ino: stat.ino };
}

/**
 * HOST-ONLY authenticated, transactional event store. The caller provisions a
 * 256-bit secret KeyObject outside the candidate workspace and retains it across
 * restarts. No key is generated, exported, logged, or written to this database.
 *
 * reserve/settle/recordStoppedAttempt are host capabilities, never model tools.
 * Authentication proves origin, not correctness: only the approved execution
 * coordinator may settle actual observations. This store grants no completion
 * or source-write authority. It cannot defend against a compromised same-UID
 * host or rollback of the entire host-owned database to an earlier valid copy.
 */
export function openAcceptanceEvidenceStore({ filePath, projectRoot, key } = {}) {
  if (!(key instanceof KeyObject) || key.type !== "secret" || key.symmetricKeySize !== 32) throw new TypeError("Expected a host-owned 256-bit secret key");
  const location = privateStateFile(filePath, projectRoot);
  const projectId = hash(location.root);
  const mac = (value) => createHmac("sha256", key).update(`${EVIDENCE_STORE_VERSION}\0${filePath}\0${projectId}\0${value}`).digest("hex");
  const authentic = (payload, signature) => typeof signature === "string" && HASH.test(signature)
    && timingSafeEqual(Buffer.from(mac(payload), "hex"), Buffer.from(signature, "hex"));
  const database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  let closed = false;
  const reservations = new WeakMap();
  function assertOpen() {
    if (closed) throw new Error("Evidence store is closed");
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== location.dev || stat.ino !== location.ino
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Evidence file identity changed");
  }
  function transaction(operation) {
    assertOpen();
    database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  let storeId;
  try {
    database.exec("PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    transaction(() => {
      if (location.created) {
        database.exec("CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, signature TEXT NOT NULL); CREATE TABLE events (scope TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(scope,sequence)) STRICT");
        const payload = JSON.stringify({ version: EVIDENCE_STORE_VERSION, storeId: randomUUID(), projectId });
        database.prepare("INSERT INTO authority VALUES (1,?,?)").run(payload, mac(payload));
      }
      const header = database.prepare("SELECT payload,signature FROM authority WHERE id=1").get();
      if (!header || !authentic(header.payload, header.signature)) throw new Error("Evidence authority is missing or unauthenticated");
      const value = JSON.parse(header.payload);
      if (value.version !== EVIDENCE_STORE_VERSION || value.projectId !== projectId || typeof value.storeId !== "string") throw new Error("Invalid evidence authority binding");
      storeId = value.storeId;
    });
    if (location.created) {
      const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } catch (error) { database.close(); throw error; }

  const scopeKey = (scope) => hash(JSON.stringify([projectId, identity(scope)]));
  function history(scope) {
    const scopeDigest = scopeKey(scope);
    const rows = database.prepare("SELECT sequence,payload,signature FROM events WHERE scope=? ORDER BY sequence LIMIT 18").all(scopeDigest);
    if (rows.length > 16) throw new Error("Evidence attempt bound exceeded");
    let latest = null, previous = null;
    for (const [index, row] of rows.entries()) {
      if (row.sequence !== index + 1 || typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_EVIDENCE_BYTES + 8192
        || !authentic(row.payload, row.signature)) throw new Error("Evidence history is corrupt or unauthenticated");
      const event = JSON.parse(row.payload);
      if (event.storeId !== storeId || event.scopeDigest !== scopeDigest || event.sequence !== row.sequence || event.previous !== previous
        || !Number.isInteger(event.maxAttempts) || event.maxAttempts < 1 || event.maxAttempts > 8
        || !["reserved", "settled", "interrupted"].includes(event.phase)) throw new Error("Invalid evidence event binding");
      bindingSnapshot(event.binding);
      if (event.phase === "reserved") {
        if (latest?.phase === "reserved" || event.attempt !== (latest?.attempt ?? 0) + 1 || event.attempt > event.maxAttempts
          || typeof event.attemptId !== "string" || (latest && event.maxAttempts !== latest.maxAttempts)) throw new Error("Invalid evidence reservation transition");
      } else if (!latest || latest.phase !== "reserved" || event.attemptId !== latest.attemptId || event.attempt !== latest.attempt
        || event.maxAttempts !== latest.maxAttempts || JSON.stringify(event.binding) !== JSON.stringify(latest.binding)
        || (event.phase === "settled" && evidenceText(event.evidenceText) !== event.evidenceText)) throw new Error("Invalid evidence terminal transition");
      latest = event;
      previous = row.signature;
    }
    return { scopeDigest, latest, previous, sequence: rows.length };
  }
  function append(current, value) {
    const event = { storeId, scopeDigest: current.scopeDigest, sequence: current.sequence + 1, previous: current.previous,
      recordedAt: new Date().toISOString(), ...value };
    const payload = JSON.stringify(event);
    database.prepare("INSERT INTO events VALUES (?,?,?,?)").run(current.scopeDigest, event.sequence, payload, mac(payload));
    return event;
  }
  const projection = (event) => frozenCopy(JSON.parse(JSON.stringify(event)));

  function latest(scope) {
    return transaction(() => projection(history(scope).latest));
  }
  function reserve({ scope, binding, maxAttempts, retry = false } = {}) {
    const exactScope = identity(scope), exactBinding = bindingSnapshot(binding);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8 || typeof retry !== "boolean") throw new TypeError("Invalid finite evidence budget");
    return transaction(() => {
      const current = history(exactScope), prior = current.latest;
      if (prior && prior.maxAttempts !== maxAttempts) throw new Error("Evidence budget cannot change within a task criterion");
      if (prior?.phase === "reserved") return Object.freeze({ status: "pending", event: projection(prior) });
      if (!retry && prior && JSON.stringify(prior.binding) === JSON.stringify(exactBinding)) {
        return Object.freeze({ status: prior.phase === "settled" ? "current" : "interrupted", event: projection(prior) });
      }
      if ((prior?.attempt ?? 0) >= maxAttempts) return Object.freeze({ status: "exhausted", event: projection(prior) });
      const event = append(current, { phase: "reserved", attemptId: randomUUID(), attempt: (prior?.attempt ?? 0) + 1, maxAttempts, binding: exactBinding });
      const reservation = Object.freeze({ attemptId: event.attemptId });
      reservations.set(reservation, { scope: exactScope, attemptId: event.attemptId });
      return Object.freeze({ status: "reserved", event: projection(event), reservation });
    });
  }
  function settle(reservation, payload) {
    const owned = reservation && reservations.get(reservation);
    if (!owned) throw new Error("Untrusted or consumed evidence reservation");
    const text = evidenceText(payload);
    const event = transaction(() => {
      const current = history(owned.scope), prior = current.latest;
      if (prior?.phase !== "reserved" || prior.attemptId !== owned.attemptId) throw new Error("Evidence reservation is no longer pending");
      return append(current, { phase: "settled", attemptId: prior.attemptId, attempt: prior.attempt,
        maxAttempts: prior.maxAttempts, binding: prior.binding, evidenceText: text });
    });
    reservations.delete(reservation);
    return projection(event);
  }
  function recordStoppedAttempt({ scope, attemptId, executorStopped = false } = {}) {
    // The host must establish that the executor is no longer active first.
    // Elapsed time, process restart, or a stale PID alone is not confirmation.
    if (executorStopped !== true) throw new Error("Executor stop must be established before recording interruption");
    return transaction(() => {
      const current = history(scope), prior = current.latest;
      if (prior?.phase !== "reserved" || prior.attemptId !== attemptId) throw new Error("No matching pending evidence attempt");
      return projection(append(current, { phase: "interrupted", attemptId: prior.attemptId, attempt: prior.attempt,
        maxAttempts: prior.maxAttempts, binding: prior.binding }));
    });
  }
  const store = Object.freeze({ version: EVIDENCE_STORE_VERSION, projectId, latest, reserve, settle, recordStoppedAttempt,
    close() { if (!closed) { database.close(); closed = true; } } });
  hostStores.add(store);
  return store;
}
