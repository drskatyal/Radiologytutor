// ============================================================================
// lib/dicomCdn/deviceCache.ts  (browser only)
//
// Converted chunks kept on the learner's device (Cache API), so reopening a
// case — or scrolling back over a slice evicted from memory — costs no
// network at all. Keys are the stable chunk path under a synthetic same-origin
// URL, never the signed CDN URL (whose signature changes every hour).
//
//   one Cache per series:  radlearn-dicom:{study}/{series}
//   budget:                DEVICE_BUDGET_BYTES, least-recently-opened series
//                          evicted first (bookkeeping in localStorage)
//
// The bytes are the same de-identified pixels the viewer already shows; they
// are cleared on sign-out (clearDicomDeviceCache) and never leave the device.
// Every call fails soft: no Cache API (old Safari, some private modes) just
// means "not cached".
// ============================================================================

const CACHE_PREFIX = "radlearn-dicom:";
const LEDGER_KEY = "radlearn:dicom-cache-ledger:v1";
const KEY_ORIGIN = "/__radlearn-dicom-cache/";

interface LedgerEntry {
  /** Cache name. */
  name: string;
  bytes: number;
  at: number;
}

function deviceBudgetBytes(): number {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (phone || (memory != null && memory <= 4)) return 400 * 1024 * 1024;
  return 2 * 1024 * 1024 * 1024;
}

function available(): boolean {
  return typeof window !== "undefined" && typeof caches !== "undefined" && window.isSecureContext !== false;
}

function readLedger(): LedgerEntry[] {
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]).filter((e) => e && typeof e.name === "string") : [];
  } catch {
    return [];
  }
}

function writeLedger(entries: LedgerEntry[]): void {
  try {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or blocked — eviction just gets less precise */
  }
}

function keyUrl(path: string): string {
  return new URL(`${KEY_ORIGIN}${path}`, window.location.origin).toString();
}

export interface DeviceSeriesCache {
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
}

/** Cache for one series. `path` is `{version}/{file}`. */
export function openDeviceSeriesCache(study: string, series: string): DeviceSeriesCache {
  const name = `${CACHE_PREFIX}${study}/${series}`;
  const prefix = `${study}/${series}/`;
  let cache: Promise<Cache | null> | null = null;
  const open = () => {
    if (!cache) cache = available() ? caches.open(name).catch(() => null) : Promise.resolve(null);
    return cache;
  };
  let touched = false;

  const note = (addBytes: number) => {
    const ledger = readLedger();
    const now = Date.now();
    const hit = ledger.find((e) => e.name === name);
    if (hit) {
      hit.at = now;
      hit.bytes += addBytes;
    } else {
      ledger.push({ name, bytes: addBytes, at: now });
    }
    writeLedger(ledger);
    if (addBytes > 0) void evictOverBudget(name);
  };

  return {
    async get(path) {
      try {
        const c = await open();
        if (!c) return null;
        const res = await c.match(keyUrl(prefix + path));
        if (!res) return null;
        if (!touched) {
          touched = true;
          note(0);
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
    async put(path, bytes) {
      try {
        const c = await open();
        if (!c) return;
        await c.put(
          keyUrl(prefix + path),
          new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/octet-stream" } })
        );
        touched = true;
        note(bytes.byteLength);
      } catch {
        /* quota or private mode */
      }
    },
  };
}

let evicting = false;

async function evictOverBudget(keep: string): Promise<void> {
  if (evicting || !available()) return;
  evicting = true;
  try {
    const budget = deviceBudgetBytes();
    const ledger = readLedger().sort((a, b) => a.at - b.at);
    let total = ledger.reduce((sum, e) => sum + e.bytes, 0);
    let quotaPressure = false;
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota && est.usage && est.usage > est.quota * 0.8) quotaPressure = true;
    } catch {
      /* no estimate */
    }
    const kept: LedgerEntry[] = [];
    for (const entry of ledger) {
      if (entry.name !== keep && (total > budget || quotaPressure)) {
        await caches.delete(entry.name).catch(() => false);
        total -= entry.bytes;
        quotaPressure = false;
        continue;
      }
      kept.push(entry);
    }
    writeLedger(kept);
  } finally {
    evicting = false;
  }
}

/** Remove every cached series from this device (sign-out). */
export async function clearDicomDeviceCache(): Promise<void> {
  if (!available()) return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n)));
  } catch {
    /* nothing to clear */
  }
  try {
    window.localStorage.removeItem(LEDGER_KEY);
  } catch {
    /* blocked */
  }
}
