import { numberValue, validateValue } from "./values.mjs";
import { INTRINSICS } from "./intrinsics.mjs";
import { approvedModuleLoader } from "./module-graph.mjs";
import { createExecutionBudget } from "./budget.mjs";
import { callbackIds } from "./capabilities.mjs";
import { createJobDrainer } from "./jobs.mjs";

/** A request-owned realm. Only explicitly contiguous sequence cases share it. */
export function createGuestSession(QuickJS, request, overallDeadline) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const budget = createExecutionBudget(overallDeadline);
  let interruption = null, importDenied = false;
  const interrupted = () => Boolean(interruption ??= budget.poll());
  runtime.setInterruptHandler(interrupted);
  const loader = approvedModuleLoader(request, () => { importDenied = true; });
  runtime.setModuleLoader(loader.load, loader.normalize);
  const context = runtime.newContext(), persistent = [], temporary = [];
  const keep = (handle) => { temporary.push(handle); return handle; };
  const retain = (handle) => { persistent.push(handle); return handle; };
  const take = (result) => {
    if (result.error) { keep(result.error); throw new Error("Guest operation failed"); }
    return keep(result.value);
  };
  const disposeTemporary = () => { while (temporary.length) temporary.pop().dispose(); };
  let namespace, methods, initializationFailure, currentCallbacks = new Set();
  function initializeIntrinsics() {
    const result = context.evalCode(INTRINSICS);
    if (result.error) { keep(result.error); throw new Error("Intrinsic initialization failed"); }
    const intrinsics = retain(result.value);
    methods = Object.fromEntries(["makeDate", "dateTime", "typeOf", "errorClass", "clockReads", "beginCall", "observeValue", "defineData",
      "beginCapabilities", "makeError", "makeCallback", "callback", "callbackFault", "callbackTrace", "errorObservation", "awaitValue", "sameReference", "referenceIdentity"]
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
      case "callback": return take(context.callFunction(methods.callback, context.undefined, keep(context.newString(value.value))));
      case "array": case "record": {
        const result = keep(value.type === "array" ? context.newArray() : context.newObject());
        value.value.forEach((entry, index) => take(context.callFunction(methods.defineData, context.undefined, result,
          keep(context.newString(value.type === "array" ? String(index) : entry.key)), input(value.type === "array" ? entry : entry.value))));
        return result;
      }
      default: throw new TypeError("Unsupported resolved input");
    }
  }
  function observe(handle, allowDate = false, allowCallbacks = false) {
    const encoded = take(context.callFunction(methods.observeValue, context.undefined, handle, allowDate ? context.true : context.false,
      allowCallbacks ? context.true : context.false));
    const result = JSON.parse(context.getString(encoded));
    if (result.reason) return result;
    validateValue(result.value, allowDate, allowCallbacks ? currentCallbacks : new Set());
    return result;
  }
  function configureCapabilities(item) {
    currentCallbacks = callbackIds(item);
    take(context.callFunction(methods.beginCapabilities, context.undefined));
    for (const error of item.errors ?? []) take(context.callFunction(methods.makeError, context.undefined,
      keep(context.newString(error.id)), keep(context.newString(error.errorClass)), keep(context.newString(error.message)),
      input(error.properties ?? { type: "record", value: [] })));
    for (const callback of item.callbacks ?? []) {
      const steps = { type: "array", value: callback.steps.map(step => ({ type: "record", value: [
        { key: "outcome", value: { type: "string", value: step.outcome } }, step.outcome === "return"
          ? { key: "value", value: step.value } : { key: "error", value: { type: "string", value: step.error } }
      ] })) };
      take(context.callFunction(methods.makeCallback, context.undefined, keep(context.newString(callback.id)), keep(context.newString(callback.mode)),
        callback.repeatLast ? context.true : context.false, input(steps), keep(context.newNumber(callback.settleAfterJobs ?? 1))));
    }
  }
  function callbackFault() {
    const value = take(context.callFunction(methods.callbackFault, context.undefined));
    return context.typeof(value) === "string" ? context.getString(value) : null;
  }
  function execute(item) {
    interruption = null; budget.beginCase();
    const incomplete = (reason, outcome = "error") => ({ id: item.id, outcome, reason,
      ...(outcome === "error" && budget.diagnostics() ? { resources: budget.diagnostics() } : {}) });
    try {
      if (interrupted()) return incomplete(interruption);
      if (initializationFailure) return { id: item.id, ...initializationFailure };
      if (!methods) initializeIntrinsics();
      take(context.callFunction(methods.beginCall, context.undefined, Object.hasOwn(item, "clock") ? context.true : context.false,
        keep(context.newNumber(item.clock ?? 0))));
      configureCapabilities(item);
      const jobs = createJobDrainer({ runtime, context, interrupted, keep });
      const drain = () => item.awaitResult ? jobs.drain()
        : runtime.hasPendingJob() ? { reason: "async-job-unsupported", outcome: "unsupported" } : null;
      const jobFailure = failure => incomplete(interrupted() ? interruption : failure.reason, interrupted() ? "error" : failure.outcome);
      const args = item.args.map(input);
      if (!namespace) {
        const moduleResult = context.evalCode(request.source, request.moduleGraph?.entry ?? "candidate.mjs", { type: "module" });
        if (moduleResult.error) {
          keep(moduleResult.error);
          const timedOut = interrupted();
          initializationFailure = { outcome: importDenied && !timedOut ? "unsupported" : "error",
            reason: timedOut ? interruption : importDenied ? "module-import-unsupported" : "module-initialization-failed" };
          return incomplete(initializationFailure.reason, initializationFailure.outcome);
        }
        const module = retain(moduleResult.value);
        const failed = drain();
        if (failed) { initializationFailure = failed; return jobFailure(failed); }
        const promise = jobs.state(module, retain);
        if (!item.awaitResult && promise.value !== module) {
          initializationFailure = { outcome: "unsupported", reason: "async-module-unsupported" };
          return { id: item.id, ...initializationFailure };
        }
        if (promise.reason) { initializationFailure = promise; return jobFailure(promise); }
        if (promise.error) {
          initializationFailure = { outcome: "error", reason: "module-initialization-failed" };
          return incomplete(initializationFailure.reason);
        }
        namespace = promise.value;
      }
      const beforeCall = drain();
      if (beforeCall) return jobFailure(beforeCall);
      const target = keep(context.getProp(namespace, item.exportName ?? request.exportName));
      if (context.getString(take(context.callFunction(methods.typeOf, context.undefined, target))) !== "function") {
        return incomplete("callable-export-missing", "unsupported");
      }
      const called = context.callFunction(target, context.undefined, args);
      let returned = keep(called.error ?? called.value), threw = Boolean(called.error);
      if (item.awaitResult && !threw) {
        const awaited = context.callFunction(methods.awaitValue, context.undefined, returned);
        returned = keep(awaited.error ?? awaited.value); threw = Boolean(awaited.error);
      }
      if (interrupted()) return incomplete(interruption);
      if (importDenied) return incomplete("module-import-unsupported", "unsupported");
      const afterCall = drain();
      if (afterCall) return jobFailure(afterCall);
      if (importDenied) return incomplete("module-import-unsupported", "unsupported");
      if (item.awaitResult && !threw) {
        const settled = jobs.state(returned);
        if (settled.reason) return jobFailure(settled);
        returned = settled.error ?? settled.value; threw = Boolean(settled.error);
      }
      const callbackError = callbackFault();
      if (callbackError) return incomplete(callbackError);
      let observation;
      if (threw) {
        const errorClass = context.getString(take(context.callFunction(methods.errorClass, context.undefined, returned)));
        if (errorClass === "InternalError") return incomplete("guest-resource-error");
        observation = { id: item.id, outcome: "throw", errorClass };
        if (item.observeError) {
          const result = JSON.parse(context.getString(take(context.callFunction(methods.errorObservation, context.undefined, returned))));
          if (result.reason) return incomplete(result.reason, "unsupported");
          observation.errorObservation = result;
        }
      } else {
        const result = observe(returned);
        if (result.reason) return incomplete(result.reason, "unsupported");
        observation = { id: item.id, outcome: "return", value: result.value };
        if (item.observeIdentity) {
          observation.returnIdentity = [];
          for (let index = 0; index < args.length; index += 1) {
            if (context.getNumber(take(context.callFunction(methods.sameReference, context.undefined, returned, args[index])))) observation.returnIdentity.push(index);
          }
        }
      }
      if (item.callbacks) observation.callbackTrace = JSON.parse(context.getString(take(context.callFunction(methods.callbackTrace, context.undefined))));
      if (item.referencePairs) {
        observation.referenceIdentity = [];
        const root = selector => selector.root === "argument" ? args[selector.index]
          : selector.root === (threw ? "error" : "return") ? returned : context.undefined;
        const path = selector => input({ type: "array", value: selector.path.map(value => ({ type: "string", value })) });
        for (const pair of item.referencePairs) {
          const result = JSON.parse(context.getString(take(context.callFunction(methods.referenceIdentity, context.undefined,
            root(pair.left), path(pair.left), root(pair.right), path(pair.right)))));
          if (result.reason) return incomplete(result.reason, "unsupported");
          observation.referenceIdentity.push({ id: pair.id, same: result.same });
        }
      }
      const dateArgsAfter = [];
      for (let index = 0; index < item.args.length; index += 1) if (item.args[index].type === "date") {
        const value = take(context.callFunction(methods.dateTime, context.undefined, args[index]));
        dateArgsAfter.push({ index, value: numberValue(context.getNumber(value)) });
      }
      if (item.observeArgs) {
        observation.argsAfter = [];
        for (const arg of args) {
          const result = observe(arg, true, true);
          if (result.reason) return incomplete(result.reason, "unsupported");
          observation.argsAfter.push(result.value);
        }
      }
      const clockReads = context.getNumber(take(context.callFunction(methods.clockReads, context.undefined)));
      if (interrupted()) return incomplete(interruption);
      if (runtime.hasPendingJob()) return incomplete("async-job-unsupported", "unsupported");
      const finalFault = callbackFault();
      if (finalFault) return incomplete(finalFault);
      return { ...observation, dateArgsAfter, clockReads };
    } catch { return incomplete(interrupted() ? interruption : "guest-observation-failed"); }
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
