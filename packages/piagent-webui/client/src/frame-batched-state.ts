import { useMemo, type Dispatch, type SetStateAction } from "react";

// Streaming text arrives as many small frames; rendering the dashboard once per
// frame of the display is enough. `later` queues an update for the next
// animation frame; `now` first applies anything queued, then its own update,
// so the order the Gateway sent them in is always kept.
export function useFrameBatchedSetter<T>(set: Dispatch<SetStateAction<T>>) {
  return useMemo(() => {
    let queue: ((value: T) => T)[] = [], frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (queue.length === 0) return;
      const pending = queue; queue = [];
      set((value) => pending.reduce((current, update) => update(current), value));
    };
    const now: Dispatch<SetStateAction<T>> = (update) => { flush(); set(update); };
    const later = (update: (value: T) => T) => {
      queue.push(update);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    return { now, later };
  }, [set]);
}

// Whether a refreshed value says nothing new: then the state keeps the object
// it had, and nothing that reads it renders again.
export function sameJson(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  try { return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next); } catch { return false; }
}
