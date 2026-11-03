// When the desktop app talks to the update channel (pure, unit-tested).
//
// The first check waits until the viewer is up (first paint) plus a quiet
// period, so it never competes with cold start or the first image; then every
// few hours. A check due while a study is opening waits for it to finish.

/** First check: this long after first paint. */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** Then every … */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** A due check postponed by a busy viewer retries after … */
export const BUSY_RETRY_MS = 30_000;
/** The running version reports "started healthily" this long after first paint. */
export const HEALTHY_AFTER_MS = 20_000;

export interface ScheduleInput {
  /** ms since the viewer first painted (null: not yet). */
  sinceFirstPaintMs: number | null;
  /** ms since the last completed check (null: none yet). */
  sinceLastCheckMs: number | null;
  /** A study is opening (scan / first decode): don't add network or disk work. */
  busy: boolean;
  /** "Check for updates automatically" in Settings. */
  enabled: boolean;
}

/** ms until the next automatic check should run; 0 = now; null = never (disabled). */
export function nextCheckInMs(s: ScheduleInput): number | null {
  if (!s.enabled) return null;
  if (s.sinceFirstPaintMs === null) return FIRST_CHECK_DELAY_MS;
  const due =
    s.sinceLastCheckMs === null
      ? Math.max(0, FIRST_CHECK_DELAY_MS - s.sinceFirstPaintMs)
      : Math.max(0, CHECK_INTERVAL_MS - s.sinceLastCheckMs);
  if (due === 0 && s.busy) return BUSY_RETRY_MS;
  return due;
}

/** What the user is told after a check that found nothing or failed. */
export function describeCheckError(error: unknown): string {
  const text = String(error ?? "");
  if (/signature|pubkey|public key|minisign/i.test(text)) return "An update was found but its signature didn't match, so it was ignored.";
  if (/network|dns|connect|timed? ?out|offline|request|fetch|status|404|5\d\d/i.test(text))
    return "Couldn't reach the update server. The viewer works fully offline; it will try again later.";
  return "Couldn't check for updates right now. It will try again later.";
}
