// Live events arrive in bursts (one turn emits several). A refresh they
// trigger is coalesced: one in flight, at most one queued behind it.
export function coalescedRefresh(run: () => Promise<unknown>, delayMs = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, again = false, stopped = false;
  const request = (): void => {
    if (stopped) return;
    if (running || timer !== undefined) { again = running; return; }
    timer = setTimeout(() => {
      timer = undefined; running = true;
      void run().catch(() => undefined).finally(() => {
        running = false;
        if (again) { again = false; request(); }
      });
    }, delayMs);
  };
  const stop = (): void => { stopped = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return { request, stop };
}
