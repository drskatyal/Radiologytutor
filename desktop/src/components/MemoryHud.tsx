// Debug memory HUD (FLOWRAD_DEBUG=1, or Ctrl+Alt+Shift+M): the whole process
// tree (exe + every WebView2 child), the JS heap, decoded-image cache, open
// volumes, live decode workers and main-thread long tasks, refreshed every 2 s.
// Loaded only when shown.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { invoke, isTauri } from "../platform";
import { longTasks, LONG_TASK_MS } from "../perfWatch";
import { decodeWorkers, enginePeek } from "../viewer/engine";

interface Tree {
  totalMb: number;
  processes: { name: string; mb: number }[];
}

interface Snapshot {
  tree: Tree | null;
  heapMb: number | null;
  cacheMb: number | null;
  volumes: number;
  workers: number;
  long: { count: number; maxMs: number };
}

const IDLE_BUDGET_MB = 400;

async function snapshot(): Promise<Snapshot> {
  const engine = enginePeek();
  const cache = engine?.core.cache as unknown as { getCacheSize?: () => number; getVolumes?: () => unknown[] } | undefined;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    tree: isTauri ? await invoke<Tree>("process_memory").catch(() => null) : null,
    heapMb: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
    cacheMb: cache?.getCacheSize ? Math.round(cache.getCacheSize() / 1048576) : null,
    volumes: cache?.getVolumes?.().length ?? 0,
    workers: decodeWorkers().live,
    long: { count: longTasks.count, maxMs: longTasks.maxMs },
  };
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={warn ? "text-warning" : "text-primary"}>{value}</dd>
    </div>
  );
}

export function MemoryHud({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Snapshot | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => void snapshot().then((next) => live && setS(next));
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const mb = (v: number | null | undefined) => (v == null ? "—" : `${v} MB`);
  return (
    <aside
      aria-label="Memory monitor"
      className="pointer-events-auto fixed bottom-3 right-3 z-50 w-64 rounded-lg border border-subtle bg-elevated/95 p-3 text-xs tabular-nums shadow-lg backdrop-blur"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-secondary">Memory</span>
        <IconButton aria-label="Close memory monitor" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {!s ? (
        <p className="text-muted">Measuring…</p>
      ) : (
        <dl className="space-y-1">
          <Row
            label="Process tree"
            value={s.tree ? `${s.tree.totalMb} MB` : "—"}
            warn={(s.tree?.totalMb ?? 0) > IDLE_BUDGET_MB}
          />
          {s.tree?.processes.slice(0, 4).map((p, i) => (
            <Row key={`${p.name}-${i}`} label={`  ${p.name.replace(/\.exe$/, "")}`} value={`${p.mb} MB`} />
          ))}
          <Row label="JS heap" value={mb(s.heapMb)} />
          <Row label="Image cache" value={mb(s.cacheMb)} />
          <Row label="Volumes" value={String(s.volumes)} />
          <Row label="Decode workers" value={String(s.workers)} />
          <Row
            label={`Tasks > ${LONG_TASK_MS} ms`}
            value={s.long.count ? `${s.long.count} (max ${s.long.maxMs} ms)` : "0"}
            warn={s.long.count > 0}
          />
        </dl>
      )}
    </aside>
  );
}
