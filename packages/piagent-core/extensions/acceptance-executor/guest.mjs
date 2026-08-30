import { numberValue, validateValue } from "./values.mjs";
import { INTRINSICS } from "./intrinsics.mjs";

/** A request-owned realm. Only explicitly contiguous sequence cases share it. */
export function createGuestSession(QuickJS, request, overallDeadline) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  let deadline = overallDeadline, interrupted = false, importDenied = false;
  runtime.setInterruptHandler(() => { interrupted ||= performance.now() >= deadline; return interrupted; });
  runtime.setModuleLoader(() => { importDenied = true; throw new Error("Closed module imports are unsupported"); });
  const context = runtime.newContext(), persistent = [], temporary = [];
  const keep = (handle) => { temporary.push(handle); return handle; };
  const retain = (handle) => { persistent.push(handle); return handle; };
  const take = (result) => {
    if (result.error) { keep(result.error); throw new Error("Guest operation failed"); }
    return keep(result.value);
  };
  const disposeTemporary = () => { while (temporary.length) temporary.pop().dispose(); };
  let namespace, methods, initializationFailure;
  function initializeIntrinsics() {
    const result = context.evalCode(INTRINSICS);
    if (result.error) { keep(result.error); throw new Error("Intrinsic initialization failed"); }
    const intrinsics = retain(result.value);
    methods = Object.fromEntries(["makeDate", "dateTime", "typeOf", "errorClass", "clockReads", "beginCall", "observeValue", "defineData"]
      .map((name) => [name, retain(context.getProp(intrinsics, name))]));
  }
  function input(value) {
    switch (value.type) {
      case "undefined": return context.undefined;
      case "null": return context.null;
      case "boolean": return value.value ? context.true : context.false;
      case "string": return keep(context.newString(value.value));
      case "number": return keep(context.newNumber(Number(value.value)));
      case "date": return take(context.callFunction(methods.makeDate, context.undefined, keep(context.newNumber(Number(value.value)))));
      case "array": case "record": {
        const result = keep(value.type === "array" ? context.newArray() : context.newObject());
        value.value.forEach((entry, index) => take(context.callFunction(methods.defineData, context.undefined, result,
          keep(context.newString(value.type === "array" ? String(index) : entry.key)), input(value.type === "array" ? entry : entry.value))));
        return result;
      }
      default: throw new TypeError("Unsupported resolved input");
    }
  }
  function observe(handle, allowDate = false) {
    const encoded = take(context.callFunction(methods.observeValue, context.undefined, handle, allowDate ? context.true : context.false));
    const result = JSON.parse(context.getString(encoded));
    if (result.reason) return result;
    validateValue(result.value, allowDate);
    return result;
  }
  function execute(item) {
    interrupted = false; deadline = Math.min(overallDeadline, performance.now() + 300);
    const incomplete = (reason, outcome = "error") => ({ id: item.id, outcome, reason });
    try {
      if (initializationFailure) return { id: item.id, ...initializationFailure };
      if (!methods) initializeIntrinsics();
      take(context.callFunction(methods.beginCall, context.undefined, Object.hasOwn(item, "clock") ? context.true : context.false,
        keep(context.newNumber(item.clock ?? 0))));
      const args = item.args.map(input);
      if (!namespace) {
        const moduleResult = context.evalCode(request.source, "candidate.mjs", { type: "module" });
        if (moduleResult.error) {
          keep(moduleResult.error);
          initializationFailure = { outcome: importDenied && !interrupted ? "unsupported" : "error",
            reason: interrupted ? "guest-timeout" : importDenied ? "module-import-unsupported" : "module-initialization-failed" };
          return { id: item.id, ...initializationFailure };
        }
        namespace = retain(moduleResult.value);
        const promise = context.getPromiseState(namespace);
        if (promise.type === "fulfilled" && !promise.notAPromise) keep(promise.value);
        if (promise.type === "rejected") keep(promise.error);
        if (!promise.notAPromise) {
          initializationFailure = { outcome: "unsupported", reason: "async-module-unsupported" };
          return { id: item.id, ...initializationFailure };
        }
      }
      const target = keep(context.getProp(namespace, item.exportName ?? request.exportName));
      if (context.getString(take(context.callFunction(methods.typeOf, context.undefined, target))) !== "function") {
        return incomplete("callable-export-missing", "unsupported");
      }
      const called = context.callFunction(target, context.undefined, args), returned = keep(called.error ?? called.value);
      if (interrupted) return incomplete("guest-timeout");
      if (importDenied) return incomplete("module-import-unsupported", "unsupported");
      let observation;
      if (called.error) {
        const errorClass = context.getString(take(context.callFunction(methods.errorClass, context.undefined, returned)));
        if (errorClass === "InternalError") return incomplete("guest-resource-error");
        observation = { id: item.id, outcome: "throw", errorClass };
      } else {
        const result = observe(returned);
        if (result.reason) return incomplete(result.reason, "unsupported");
        observation = { id: item.id, outcome: "return", value: result.value };
      }
      const dateArgsAfter = [];
      for (let index = 0; index < item.args.length; index += 1) if (item.args[index].type === "date") {
        const value = take(context.callFunction(methods.dateTime, context.undefined, args[index]));
        dateArgsAfter.push({ index, value: numberValue(context.getNumber(value)) });
      }
      if (item.observeArgs) {
        observation.argsAfter = [];
        for (const arg of args) {
          const result = observe(arg, true);
          if (result.reason) return incomplete(result.reason, "unsupported");
          observation.argsAfter.push(result.value);
        }
      }
      const clockReads = context.getNumber(take(context.callFunction(methods.clockReads, context.undefined)));
      if (interrupted) return incomplete("guest-timeout");
      return { ...observation, dateArgsAfter, clockReads };
    } catch { return incomplete(interrupted ? "guest-timeout" : "guest-observation-failed"); }
    finally { disposeTemporary(); }
  }
  return { execute, dispose() {
    disposeTemporary(); while (persistent.length) persistent.pop().dispose(); context.dispose(); runtime.dispose();
  } };
}

export function executeCase(QuickJS, request, item, overallDeadline) {
  const session = createGuestSession(QuickJS, request, overallDeadline);
  try { return session.execute(item); } finally { session.dispose(); }
}
