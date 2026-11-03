// Cutting pure, CPU-bound work into slices the main thread can breathe between.
//
// The work is written once, as a generator that `yield`s at safe points (between
// series, every few thousand headers). The same generator then runs two ways:
//   - `runToCompletion`: synchronously, start to finish (tests, small inputs);
//   - `runSliced`: a slice at a time, giving the event loop back whenever a
//     slice has used its budget, so no single task gets near the 50 ms
//     long-task line however big the study is.
// One code path means the sliced result is the synchronous result, by
// construction: the opening of a 10,310-image MRI groups exactly as before,
// just not in one 70 ms block.

/** A unit of slice-able work: yields between steps, returns the result. */
export type SlicedWork<T> = Generator<void, T, void>;

/** Run sliced work to the end without ever giving the thread back. */
export function runToCompletion<T>(work: SlicedWork<T>): T {
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

/**
 * Give the main thread back with a macrotask boundary: input, paint and other
 * tasks run before the work resumes. A resolved promise is NOT enough (a
 * microtask continues the same task).
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** What `runSliced` measured: how the work was cut. */
export interface SliceStats {
  /** Tasks the work ran in (1 = it never had to yield). */
  slices: number;
  /** The longest single slice, ms: the main-thread stall this work caused. */
  maxSliceMs: number;
  /** Time spent working (excluding time given back), ms. */
  busyMs: number;
}

export interface RunSlicedOptions {
  /**
   * Work this long before giving the thread back. Default 8 ms: one step can
   * overrun it a little, and the slice still ends far below 50 ms.
   */
  budgetMs?: number;
  /** Checked at every step; true abandons the work (`runSliced` resolves undefined). */
  isCancelled?: () => boolean;
  /** How to give the thread back. Default `yieldToEventLoop`. */
  yieldFn?: () => Promise<void>;
  /** Clock. Default `performance.now`. */
  now?: () => number;
  /** Told how the work was sliced, when it finishes (not when cancelled). */
  onStats?: (stats: SliceStats) => void;
}

export const DEFAULT_SLICE_BUDGET_MS = 8;

/**
 * Run sliced work, yielding to the event loop whenever a slice has used its
 * budget. Resolves the work's result, or undefined when cancelled. A small
 * input finishes inside its first slice and never yields.
 */
export async function runSliced<T>(work: SlicedWork<T>, options: RunSlicedOptions = {}): Promise<T | undefined> {
  const budget = options.budgetMs ?? DEFAULT_SLICE_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  const stats: SliceStats = { slices: 1, maxSliceMs: 0, busyMs: 0 };
  let sliceStart = now();
  for (;;) {
    if (options.isCancelled?.()) {
      work.return(undefined as unknown as T);
      return undefined;
    }
    const step = work.next();
    const elapsed = now() - sliceStart;
    if (step.done) {
      stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
      stats.busyMs += elapsed;
      options.onStats?.(stats);
      return step.value;
    }
    if (elapsed >= budget) {
      stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
      stats.busyMs += elapsed;
      await yieldFn();
      stats.slices += 1;
      sliceStart = now();
    }
  }
}
