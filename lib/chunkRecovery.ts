// Recovery from code that failed to load (webpack ChunkLoadError, a failed
// dynamic import, a CSS chunk). This happens to an open tab when a deploy
// swaps the build under it, or when one request is dropped on the way.
//
// The policy, in order:
//   1. Retry the import: twice, with backoff. webpack forgets a failed chunk,
//      so the same import() asks again. But chunks are served `immutable`, so
//      "again" is answered by the browser's HTTP cache: a bad copy stored once
//      (a response cut off mid-deploy) would fail every retry AND every reload,
//      forever, for that one browser. So before each retry the failing file is
//      fetched with `cache: "reload"`, which replaces the cached copy.
//   2. Still failing: reload the page once, so the tab gets the live build.
//      A sessionStorage stamp stops a reload loop: if this tab already
//      reloaded for this reason in the last few minutes, do not reload again;
//      the caller shows a calm "could not load" state with a Reload button.
//   3. Before reloading, the caller saves where the user was (`savePlace`),
//      and reads it back after (`takeSavedPlace`).
//
// Nothing here logs or stores anything about a study: places are numbers.

const RELOAD_KEY = "flowrad:chunk-reload";
const PLACE_KEY = "flowrad:chunk-reload-place";
/** A second chunk failure within this window does not reload again. */
const RELOAD_LOOP_WINDOW_MS = 5 * 60_000;

/** Webpack / Next / browser wordings of "this script or module did not load". */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  const text = typeof message === "string" ? message : "";
  return /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load chunk/i.test(
    text
  );
}

/** The file a webpack chunk error names: `error.request`, or "(missing: URL)" in the message. */
export function failedChunkUrl(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { request, message } = error as { request?: unknown; message?: unknown };
  const candidates = [typeof request === "string" ? request : ""];
  if (typeof message === "string") {
    const m = message.match(/\((?:missing|error|timeout)?:?\s*([^\s()]+)\)/);
    if (m) candidates.push(m[1]);
  }
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
      const url = new URL(raw, base);
      // Only our own static files: never refetch anything off-origin.
      if (typeof window !== "undefined" && url.origin !== window.location.origin) continue;
      if (!url.pathname.includes("/_next/static/")) continue;
      return url.href;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/**
 * Re-download the chunk an error names, bypassing (and so replacing) the
 * browser's cached copy. Returns the HTTP status, or null when there is no
 * URL to refresh or the network failed. A 404 means the file is gone from
 * the server: a new build replaced it, and only a page reload can help.
 */
export async function refreshFailedChunk(
  error: unknown,
  fetcher: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined
): Promise<number | null> {
  const url = failedChunkUrl(error);
  if (!url || !fetcher) return null;
  try {
    const res = await fetcher(url, { cache: "reload", credentials: "same-origin" });
    // Read the body so the fresh copy is fully stored before the retry.
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  /** First backoff; doubled (+ jitter) per retry. */
  baseDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: refetch the failing chunk past the HTTP cache (refreshFailedChunk). */
  refresh?: (error: unknown) => Promise<number | null>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `load` (an `import()`), retrying a chunk-load failure `retries` times
 * with exponential backoff. Any other error is rethrown at once: a module
 * that loads and then throws is a bug, not a network blip.
 */
export async function importWithRetry<T>(load: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const base = options.baseDelayMs ?? 400;
  const sleep = options.sleep ?? defaultSleep;
  const refresh = options.refresh ?? ((error: unknown) => refreshFailedChunk(error));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (!isChunkLoadError(error) || attempt >= retries) throw error;
      // Replace a bad cached copy before asking again. Gone from the server
      // (404): a newer build is live; retrying cannot help, the caller reloads.
      const status = await refresh(error);
      if (status === 404 || status === 410) throw error;
      await sleep(base * 2 ** attempt + Math.round(Math.random() * base * 0.25));
    }
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function session(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // storage blocked (private mode, sandboxed iframe)
  }
}

/**
 * May this tab reload itself for a chunk failure now? False when it already
 * did within the loop window (or storage is unavailable: no guard, no reload).
 */
export function mayReloadForChunkError(now = Date.now(), storage: StorageLike | null = session()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? 0);
    return !(last > 0 && now - last < RELOAD_LOOP_WINDOW_MS);
  } catch {
    return false;
  }
}

/** Where the user was, so the reloaded page can put them back. Numbers only. */
export interface SavedPlace {
  path: string;
  scrollY: number;
  /** Viewer-specific numbers (study / series / slice index). */
  viewer?: Record<string, number>;
  savedAt: number;
}

export function savePlace(viewer?: Record<string, number>, storage: StorageLike | null = session()): void {
  if (!storage || typeof window === "undefined") return;
  const place: SavedPlace = {
    path: window.location.pathname + window.location.search + window.location.hash,
    scrollY: Math.round(window.scrollY),
    viewer,
    savedAt: Date.now(),
  };
  try {
    storage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    /* quota / blocked: reload without a place */
  }
}

/** The place saved before a recovery reload on this path, once; then it is gone. */
export function takeSavedPlace(storage: StorageLike | null = session()): SavedPlace | null {
  if (!storage || typeof window === "undefined") return null;
  try {
    const raw = storage.getItem(PLACE_KEY);
    if (!raw) return null;
    storage.removeItem(PLACE_KEY);
    const place = JSON.parse(raw) as SavedPlace;
    const here = window.location.pathname + window.location.search + window.location.hash;
    if (place.path !== here || Date.now() - place.savedAt > RELOAD_LOOP_WINDOW_MS) return null;
    return place;
  } catch {
    return null;
  }
}

/**
 * Reload once to pick up the live build. Returns false (and does nothing)
 * when this tab already reloaded for a chunk failure recently: the caller
 * then shows its "could not load" state instead of looping.
 */
export function reloadForChunkError(viewer?: Record<string, number>): boolean {
  const storage = session();
  if (!mayReloadForChunkError(Date.now(), storage)) return false;
  try {
    storage!.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  savePlace(viewer, storage);
  window.location.reload();
  return true;
}

/** Call once the page has run cleanly for a while: the next failure may reload again. */
export function clearChunkReloadGuard(storage: StorageLike | null = session()): void {
  try {
    storage?.removeItem(RELOAD_KEY);
  } catch {
    /* blocked */
  }
}
