import { MAX_STRING_LENGTH, numberValue } from "./protocol.mjs";

// Captured before candidate evaluation; never installed on the guest global.
// No host function, file, network, process, expected result, or receipt capability
// is bound into the guest realm. Intrinsic methods are captured, not looked up
// through candidate-writable prototypes when observing a result.
const INTRINSICS = `(() => {
  const D = Date, apply = Reflect.apply, isPrototypeOf = Object.prototype.isPrototypeOf;
  const getTime = D.prototype.getTime;
  const internalError = InternalError.prototype;
  const prototypes = [TypeError.prototype, RangeError.prototype, SyntaxError.prototype,
    ReferenceError.prototype, EvalError.prototype, URIError.prototype, Error.prototype];
  const names = ['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'Error'];
  let reads = 0;
  return {
    makeDate: (value) => new D(value),
    dateTime: (value) => apply(getTime, value, []),
    typeOf: (value) => typeof value,
    clockReads: () => reads,
    setClock: (value) => { D.now = () => { reads += 1; return value; }; },
    errorClass: (value) => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return 'non-error';
      if (apply(isPrototypeOf, internalError, [value])) return 'InternalError';
      for (let i = 0; i < prototypes.length; i += 1) {
        if (apply(isPrototypeOf, prototypes[i], [value])) return names[i];
      }
      return 'non-error';
    }
  };
})()`;

export function executeCase(QuickJS, request, item, overallDeadline) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Math.min(overallDeadline, performance.now() + 300);
  let interrupted = false;
  let importDenied = false;
  runtime.setInterruptHandler(() => {
    interrupted ||= performance.now() >= deadline;
    return interrupted;
  });
  runtime.setModuleLoader(() => {
    importDenied = true;
    throw new Error("Imports are not supported by this closed-module adapter");
  });
  const context = runtime.newContext();
  const handles = [];
  const keep = (handle) => { handles.push(handle); return handle; };
  const incomplete = (reason, outcome = "error") => ({ id: item.id, outcome, reason });
  function take(result) {
    if (result.error) { keep(result.error); throw new Error("Guest operation failed"); }
    return keep(result.value);
  }
  try {
    const intrinsics = take(context.evalCode(INTRINSICS));
    const method = (name) => keep(context.getProp(intrinsics, name));
    const makeDate = method("makeDate"), dateTime = method("dateTime"), typeOf = method("typeOf");
    const errorClass = method("errorClass"), clockReads = method("clockReads");
    if (Object.hasOwn(item, "clock")) take(context.callFunction(method("setClock"), context.undefined, keep(context.newNumber(item.clock))));
    function input(value) {
      switch (value.type) {
        case "undefined": return context.undefined;
        case "null": return context.null;
        case "boolean": return value.value ? context.true : context.false;
        case "string": return keep(context.newString(value.value));
        case "number": return keep(context.newNumber(Number(value.value)));
        case "date": return take(context.callFunction(makeDate, context.undefined, keep(context.newNumber(Number(value.value)))));
        default: throw new TypeError("Unsupported input");
      }
    }
    // Construct inputs before candidate initialization so input construction
    // cannot be replaced by candidate modifications of Date or its prototype.
    const args = item.args.map(input);
    const moduleResult = context.evalCode(request.source, "candidate.mjs", { type: "module" });
    if (moduleResult.error) {
      keep(moduleResult.error);
      return incomplete(interrupted ? "guest-timeout" : importDenied ? "module-import-unsupported" : "module-initialization-failed",
        importDenied && !interrupted ? "unsupported" : "error");
    }
    const namespace = keep(moduleResult.value);
    const promise = context.getPromiseState(namespace);
    if (promise.type === "fulfilled" && !promise.notAPromise) keep(promise.value);
    if (promise.type === "rejected") keep(promise.error);
    if (!promise.notAPromise) return incomplete("async-module-unsupported", "unsupported");
    const target = keep(context.getProp(namespace, request.exportName));
    if (context.getString(take(context.callFunction(typeOf, context.undefined, target))) !== "function") {
      return incomplete("callable-export-missing", "unsupported");
    }
    const called = context.callFunction(target, context.undefined, args);
    const returned = keep(called.error ?? called.value);
    if (interrupted) return incomplete("guest-timeout");
    if (importDenied) return incomplete("module-import-unsupported", "unsupported");
    let observation;
    if (called.error) {
      observation = { id: item.id, outcome: "throw", errorClass: context.getString(take(context.callFunction(errorClass, context.undefined, returned))) };
      if (observation.errorClass === "InternalError") return incomplete("guest-resource-error");
    } else {
      const type = context.getString(take(context.callFunction(typeOf, context.undefined, returned)));
      let value;
      if (context.eq(returned, context.null)) value = { type: "null" };
      else if (type === "undefined") value = { type };
      else if (type === "boolean") value = { type, value: context.eq(returned, context.true) };
      else if (type === "number") value = { type, value: numberValue(context.getNumber(returned)) };
      else if (type === "string") {
        const string = context.getString(returned);
        if (string.length > MAX_STRING_LENGTH) return incomplete("returned-string-limit", "unsupported");
        value = { type, value: string };
      } else return incomplete("return-type-unsupported", "unsupported");
      observation = { id: item.id, outcome: "return", value };
    }
    const dateArgsAfter = [];
    for (let index = 0; index < item.args.length; index += 1) {
      if (item.args[index].type === "date") {
        const dateValue = take(context.callFunction(dateTime, context.undefined, args[index]));
        dateArgsAfter.push({ index, value: numberValue(context.getNumber(dateValue)) });
      }
    }
    const reads = context.getNumber(take(context.callFunction(clockReads, context.undefined)));
    if (interrupted) return incomplete("guest-timeout");
    return { ...observation, dateArgsAfter, clockReads: reads };
  } catch {
    return incomplete(interrupted ? "guest-timeout" : "guest-observation-failed");
  } finally {
    for (let index = handles.length - 1; index >= 0; index -= 1) handles[index].dispose();
    context.dispose();
    runtime.dispose();
  }
}
