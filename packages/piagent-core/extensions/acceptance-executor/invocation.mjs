import { protocolShape as shape } from "./values.mjs";

const RECEIVER = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,79}$/;
const METHOD = /^(?:set|get)$/;

/** Validate the finite v2 invocation language. Receiver history is checked by protocol.mjs. */
export function validateInvocation(value) {
  if (value?.kind === "call") shape(value, ["kind"]);
  else if (value?.kind === "construct") {
    shape(value, ["kind", "receiverId"]);
    if (typeof value.receiverId !== "string" || !RECEIVER.test(value.receiverId)) throw new TypeError("Invalid constructor receiver");
  } else if (value?.kind === "method") {
    shape(value, ["kind", "receiverId", "method"]);
    if (typeof value.receiverId !== "string" || !RECEIVER.test(value.receiverId)
      || typeof value.method !== "string" || !METHOD.test(value.method)) throw new TypeError("Invalid receiver method");
  } else throw new TypeError("Invalid invocation");
  return value;
}

export function invocationTrace(item, outcome) {
  const invocation = item.invocation ?? { kind: "call" };
  return {
    kind: invocation.kind,
    ...(invocation.kind === "call" ? { exportName: item.exportName } : {}),
    ...(invocation.receiverId ? { receiverId: invocation.receiverId } : {}),
    ...(invocation.method ? { method: invocation.method } : {}),
    outcome
  };
}

// Evaluated in the private observer closure before candidate code. Captured
// Reflect operations cannot be replaced by candidate prototype/global writes.
export const INVOCATION_INTRINSICS = `
  const invokeTarget = (target, receiver, kind, method, args) => {
    if (kind === 'construct') return construct(target, args);
    if (kind === 'method') return apply(receiver[method], receiver, args);
    return apply(target, undefined, args);
  };
`;
