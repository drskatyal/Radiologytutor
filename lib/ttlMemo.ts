// A bounded, time-to-live memo for request-path lookups.
//
// `/api/dicomweb` is the one route in this app that runs once per *frame*. A
// reader scrolling a 500-slice CT issues 500 requests in a few seconds, and
// each one has to answer three questions before a byte of pixel data moves:
// who is this, which org are they in, and does that org own this study. All
// three answers are stable for the length of a scroll and expensive to
// recompute (a Better Auth session read plus a studies-collection scan), so
// the route memoizes them.
//
// It used to hand-roll that memo three times, inline, with a copy of the same
// "sweep expired entries when the map gets big" loop each time. This is that
// loop once, with tests, so a new memo on the frame path is three lines and
// cannot forget the bound.
//
// Deliberately NOT an LRU: entries are cheap, the TTL is short, and the
// failure mode we care about is unbounded growth on a long-lived server, not
// eviction quality. Negative results are cacheable too — a probing loop
// against study UIDs it does not own must stay cheap.

export interface TtlMemoOptions {
  /** How long an entry may be served. */
  ttlMs: number;
  /** Entries at which a sweep of expired keys runs. */
  maxEntries: number;
  /** Clock seam, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface TtlMemo<T> {
  /** The live value, or `undefined` when absent or expired. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Entries currently held, expired ones included. */
  size(): number;
  delete(key: string): void;
  clear(): void;
}

export function createTtlMemo<T>(options: TtlMemoOptions): TtlMemo<T> {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; at: number }>();

  const sweep = (stamp: number) => {
    for (const [key, entry] of entries) {
      if (stamp - entry.at >= ttlMs) entries.delete(key);
    }
    // Still over the bound after a sweep: every entry is live, so drop the
    // oldest insertions (Map iterates in insertion order) rather than grow.
    if (entries.size > maxEntries) {
      const excess = entries.size - maxEntries;
      let dropped = 0;
      for (const key of entries.keys()) {
        if (dropped >= excess) break;
        entries.delete(key);
        dropped += 1;
      }
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      const stamp = now();
      entries.set(key, { value, at: stamp });
      if (entries.size > maxEntries) sweep(stamp);
    },
    size() {
      return entries.size;
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
