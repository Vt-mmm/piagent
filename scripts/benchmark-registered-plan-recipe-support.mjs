const PROTOCOL_VALUE = Symbol("protocol-value");

function specialNumber(value) {
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  if (!Number.isFinite(value)) return String(value);
  return value;
}

export function protocolRecord(entries) {
  return {
    [PROTOCOL_VALUE]: true,
    type: "record",
    value: entries.map(([key, value]) => ({ key, value: encodeBenchmarkValue(value) }))
  };
}

export function protocolArray(values) {
  return { [PROTOCOL_VALUE]: true, type: "array", value: values.map(encodeBenchmarkValue) };
}

export function encodeBenchmarkValue(value) {
  if (value?.[PROTOCOL_VALUE] === true) return value;
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") return { type: "number", value: specialNumber(value) };
  if (typeof value === "string") return { type: "string", value };
  if (value instanceof Uint8Array) {
    const backing = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { type: "uint8array", value: {
      backingBase64: backing.toString("base64"), byteOffset: 0, byteLength: backing.length
    } };
  }
  if (Array.isArray(value)) return protocolArray(value);
  if (value && typeof value === "object") return protocolRecord(Object.entries(value));
  throw new TypeError("Unsupported authored benchmark value");
}

function observedArgs(args, observeArgs) {
  const encoded = args.map(encodeBenchmarkValue);
  return { encoded, ...(observeArgs ? { observeArgs: true, argsAfter: encoded } : {}) };
}

export function callReturns(id, args, value, options = {}) {
  const { encoded, observeArgs, argsAfter } = observedArgs(args, options.observeArgs !== false);
  return {
    id,
    args: encoded,
    invocation: { kind: "call" },
    ...(options.exportName ? { exportName: options.exportName } : {}),
    ...(observeArgs ? { observeArgs } : {}),
    ...(options.fresh ? { observeIdentity: true } : {}),
    ...(options.referencePairs ? { referencePairs: options.referencePairs } : {}),
    expected: {
      outcome: "return",
      value: encodeBenchmarkValue(value),
      ...(observeArgs ? { argsAfter } : {}),
      ...(options.fresh ? { returnIdentity: [] } : {}),
      ...(options.referenceIdentity ? { referenceIdentity: options.referenceIdentity } : {})
    }
  };
}

export function callThrows(id, args, errorClass = "TypeError", options = {}) {
  const { encoded, observeArgs, argsAfter } = observedArgs(args, options.observeArgs !== false);
  return {
    id,
    args: encoded,
    invocation: { kind: "call" },
    ...(options.exportName ? { exportName: options.exportName } : {}),
    ...(observeArgs ? { observeArgs } : {}),
    expected: { outcome: "throw", errorClass, ...(observeArgs ? { argsAfter } : {}) }
  };
}

export function recipe(sourcePath, exportName, cases) {
  return Object.freeze({ sourcePath, exportName,
    checks: Object.freeze([{ id: "public-contract-cases", cases: Object.freeze(cases) }]) });
}

export function utf8Chunks(text, cuts = []) {
  const bytes = Buffer.from(text), points = [0, ...cuts, bytes.length];
  return points.slice(0, -1).map((start, index) => new Uint8Array(bytes.subarray(start, points[index + 1])));
}
