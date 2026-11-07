import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePoolSize, installLazyWorkerPool, pickSlot } from "./viewer/workerPool";

test("decode pool: cores minus two, 1–8", () => {
  assert.equal(decodePoolSize(1), 1);
  assert.equal(decodePoolSize(4), 2);
  assert.equal(decodePoolSize(8), 6);
  assert.equal(decodePoolSize(16), 8);
});

test("pickSlot reuses an idle live worker, spawns only when all live ones are busy", () => {
  assert.deepEqual(pickSlot([false, false, false], [0, 0, 0]), { index: 0, spawn: true });
  assert.deepEqual(pickSlot([true, false, false], [0, 0, 0]), { index: 0, spawn: false });
  assert.deepEqual(pickSlot([true, false, false], [2, 0, 0]), { index: 1, spawn: true });
  // A gap left by a reaped worker is filled (Cornerstone's own picker never does).
  assert.deepEqual(pickSlot([false, true, false], [0, 1, 0]), { index: 0, spawn: true });
  // Full and busy: least-loaded live worker.
  assert.deepEqual(pickSlot([true, true], [3, 1]), { index: 1, spawn: false });
});

test("lazy pool: no workers until used, grows on demand, frees idle ones", () => {
  let spawned = 0;
  let terminated = 0;
  const fakeWorker = () => ({ terminate: () => (terminated += 1) }) as unknown as Worker;
  const registry = {
    dicomImageLoader: {
      workerFn: () => ((spawned += 1), fakeWorker()),
      instances: [{}] as (unknown | null)[],
      nativeWorkers: [fakeWorker()] as (Worker | null)[],
      loadCounters: [0],
      lastActiveTime: [null] as (number | null)[],
    },
  };
  const manager = {
    workerRegistry: registry,
    getNextWorkerAPI: () => null,
    terminateWorkerInstance(name: "dicomImageLoader", i: number) {
      const s = registry[name];
      if (s.instances[i] == null) return;
      s.nativeWorkers[i]!.terminate();
      s.instances[i] = null;
      s.lastActiveTime[i] = null;
    },
  };
  const pool = installLazyWorkerPool(manager, "dicomImageLoader", 4, (w) => ({ w }))!;
  pool.releaseIdle();
  assert.equal(pool.live(), 0, "the init-time worker is freed while idle");
  const a = manager.getNextWorkerAPI("dicomImageLoader")!; // busy
  const b = manager.getNextWorkerAPI("dicomImageLoader")!;
  assert.notEqual(a.index, b.index);
  assert.equal(pool.live(), 2);
  assert.equal(spawned, 2);
  registry.dicomImageLoader.loadCounters[a.index] -= 1;
  registry.dicomImageLoader.loadCounters[b.index] -= 1;
  manager.getNextWorkerAPI("dicomImageLoader");
  assert.equal(spawned, 2, "an idle live worker is reused");
  registry.dicomImageLoader.loadCounters.fill(0);
  pool.releaseIdle();
  assert.equal(pool.live(), 0);
  assert.ok(terminated >= 3);
  pool.dispose();
});
