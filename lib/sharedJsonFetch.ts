// One in-flight request per URL for the small JSON reads that open a stack.
//
// The page prewarm (lib/viewerWarmup.ts) and the viewer (lib/progressiveStack.ts)
// both need the same 1-row QIDO and the same opening instance's metadata, and
// they start within milliseconds of each other. The HTTP cache only helps
// once a response has COMPLETED, so on a 620 ms archive both went to the
// network: two QIDOs and two metadata reads per open (benchmark: 2 + 2).
// Sharing the promise in JS makes the second caller wait for the first.
//
// Entries live for SHARED_TTL_MS (a page open), never forever: series lists
// change after an upload. Callers must treat the value as read-only.

export const SHARED_TTL_MS = 30_000;

type Entry = { at: number; promise: Promise<unknown | null> };
const entries = new Map<string, Entry>();

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * GET `url` as JSON, sharing one network request among concurrent callers.
 * Resolves null on a non-2xx. A caller's AbortSignal only detaches that
 * caller; the shared request keeps going for the others.
 */
export function fetchJsonShared(
  url: string,
  opts: { accept?: string; signal?: AbortSignal; fetchImpl?: FetchLike; now?: number } = {}
): Promise<unknown | null> {
  const now = opts.now ?? Date.now();
  const hit = entries.get(url);
  if (hit && now - hit.at < SHARED_TTL_MS) return abortable(hit.promise, opts.signal);
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const promise = doFetch(url, {
    credentials: "same-origin",
    cache: "default",
    headers: { Accept: opts.accept ?? "application/dicom+json" },
  })
    .then(async (res) => (res.ok ? ((await res.json()) as unknown) : null))
    .catch(() => {
      entries.delete(url);
      return null;
    });
  entries.set(url, { at: now, promise });
  // Do not remember failures: a 401 before the cookie lands must not stick.
  void promise.then((v) => {
    if (v == null) entries.delete(url);
  });
  return abortable(promise, opts.signal);
}

/** Tests only. */
export function resetSharedJson(): void {
  entries.clear();
}
