export const MAX_ASYNC_JOBS = 1024;

/** Bounded guest jobs only. No host await, IO callback, timer or Promise hook. */
export function createJobDrainer({ runtime, context, interrupted, keep }) {
  let jobs = 0;
  return {
    drain() {
      while (runtime.hasPendingJob()) {
        if (interrupted()) return { reason: "async-job-interrupted", outcome: "error" };
        if (jobs >= MAX_ASYNC_JOBS) return { reason: "async-job-limit", outcome: "error" };
        const result = runtime.executePendingJobs(1);
        if (result.error) { keep(result.error); return { reason: "async-job-failed", outcome: "error" }; }
        if (result.value !== 1) return { reason: "async-job-stalled", outcome: "error" };
        jobs += 1;
      }
      // An interrupt can reject the final Promise while executePendingJobs
      // itself reports one successfully processed job. Preserve the budget
      // stop before its InternalError is mistaken for an ordinary rejection.
      return interrupted() ? { reason: "async-job-interrupted", outcome: "error" } : null;
    },
    state(handle, retain = keep) {
      const state = context.getPromiseState(handle);
      if (state.notAPromise) return { value: handle };
      if (state.type === "fulfilled") return { value: retain(state.value) };
      if (state.type === "rejected") return { error: retain(state.error) };
      return { reason: "async-promise-unsettled", outcome: "unsupported" };
    }
  };
}
