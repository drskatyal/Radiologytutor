// One lazy, shared decode-worker pool.
//
// `@cornerstonejs/dicom-image-loader`'s init() registers its worker with
// Cornerstone's CentralizedWorkerManager, which spawns EVERY instance up front
// (12 on a 16-thread PC, each a module worker that grows its own WASM codec
// heaps) and never frees them. Its optional idle reaper has an indexing bug:
// once instances are terminated it only ever re-spawns slot 0, so decoding
// collapses to one worker.
//
// Here: init the loader with ONE instance, then widen the slot arrays to the
// pool size with empty slots, and replace slot selection for this worker
// type: reuse an idle live worker, spawn into an empty slot only when every
// live one is busy, and reap workers idle for `idleMs` (keeping `keepWarm`).
// Nothing runs until something is decoded.

/** Decode workers for this machine: the cores minus two (UI + Rust), 1–8. */
export function decodePoolSize(cores: number): number {
  return Math.max(1, Math.min(8, Math.floor(cores) - 2));
}

interface Slots {
  workerFn: () => Worker;
  instances: (unknown | null)[];
  nativeWorkers: (Worker | null)[];
  loadCounters: number[];
  lastActiveTime: (number | null)[];
}

interface Manager {
  workerRegistry: Record<string, Slots>;
  getNextWorkerAPI(name: string): { api: unknown; index: number } | null;
  terminateWorkerInstance(name: string, index: number): void;
}

export interface PoolHandle {
  /** Live worker count. */
  live(): number;
  /** Terminate every idle worker now (a feature closed, the study closed). */
  releaseIdle(): void;
  dispose(): void;
}

/** Slot choice, pure for tests: index of the worker to use, and whether to spawn there. */
export function pickSlot(live: readonly boolean[], load: readonly number[]): { index: number; spawn: boolean } {
  let best = -1;
  for (let i = 0; i < live.length; i += 1) {
    if (live[i] && (best < 0 || load[i] < load[best])) best = i;
  }
  if (best >= 0 && load[best] === 0) return { index: best, spawn: false };
  const empty = live.findIndex((l) => !l);
  if (empty >= 0) return { index: empty, spawn: true };
  return { index: Math.max(0, best), spawn: false };
}

export function installLazyWorkerPool(
  manager: unknown,
  name: string,
  size: number,
  wrap: (w: Worker) => unknown,
  { idleMs = 15_000, keepWarm = 1 }: { idleMs?: number; keepWarm?: number } = {}
): PoolHandle | null {
  const m = manager as Manager;
  const slots = m?.workerRegistry?.[name];
  if (!slots || typeof m.getNextWorkerAPI !== "function") return null;
  // Widen to `size` slots; existing (eager) ones beyond the first are freed.
  for (let i = 1; i < slots.instances.length; i += 1) m.terminateWorkerInstance(name, i);
  const pad = <T,>(a: T[], v: T) => {
    a.length = Math.min(a.length, size);
    while (a.length < size) a.push(v);
  };
  pad(slots.instances, null);
  pad(slots.nativeWorkers, null);
  pad(slots.loadCounters, 0);
  pad(slots.lastActiveTime, null);

  const original = m.getNextWorkerAPI.bind(m);
  m.getNextWorkerAPI = (workerName: string) => {
    if (workerName !== name) return original(workerName);
    const s = m.workerRegistry[name];
    const { index, spawn } = pickSlot(
      s.instances.map((x) => x != null),
      s.loadCounters
    );
    if (spawn || s.instances[index] == null) {
      const worker = s.workerFn();
      s.nativeWorkers[index] = worker;
      s.instances[index] = wrap(worker);
    }
    s.loadCounters[index] += 1;
    s.lastActiveTime[index] = Date.now();
    return { api: s.instances[index], index };
  };

  const reap = (all: boolean) => {
    const s = m.workerRegistry[name];
    if (!s) return;
    const now = Date.now();
    let kept = 0;
    // Keep the most recently used warm ones.
    const order = s.instances
      .map((_, i) => i)
      .filter((i) => s.instances[i] != null)
      .sort((a, b) => (s.lastActiveTime[b] ?? 0) - (s.lastActiveTime[a] ?? 0));
    for (const i of order) {
      const idle = s.loadCounters[i] === 0 && now - (s.lastActiveTime[i] ?? 0) > (all ? -1 : idleMs);
      if (!idle) continue;
      if (!all && kept < keepWarm && now - (s.lastActiveTime[i] ?? 0) < idleMs * 4) {
        kept += 1;
        continue;
      }
      m.terminateWorkerInstance(name, i);
    }
  };
  const timer = setInterval(() => reap(false), Math.max(1000, idleMs / 3));
  return {
    live: () => (m.workerRegistry[name]?.instances ?? []).filter((x) => x != null).length,
    releaseIdle: () => reap(true),
    dispose: () => clearInterval(timer),
  };
}
