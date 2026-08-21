// Performance plan — interleave spoken beats with viewer drive.
// The examiner speaks AND moves the image in the same turn. We never wait
// for a full laser tween before starting TTS, and we never invent extra
// actions: each drive comes from the tutor's tool calls.

export interface DriveAction {
  type: string;
  findingId?: string;
  windowWidth?: number;
  windowCenter?: number;
  x_pct?: number;
  y_pct?: number;
}

export interface PerformanceBeat<T = DriveAction> {
  text: string;
  actions: T[];
}

/** Split spoken tutor copy into sentence-sized TTS chunks. */
export function splitSentences(text: string): string[] {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw
    .split(/(?<=[.!?])\s+|(?<=;)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [raw];
}

/**
 * Pair sentences with viewer actions. First action lands on the first beat
 * (look + speak together). Extra actions spread onto later beats; leftovers
 * pile on the last beat so nothing is dropped.
 */
export function buildPerformancePlan<T>(
  answer: string,
  actions: T[] = []
): PerformanceBeat<T>[] {
  const sentences = splitSentences(answer);
  const drives = actions.filter(Boolean);
  if (sentences.length === 0) {
    return drives.length > 0 ? [{ text: "", actions: drives }] : [];
  }
  if (drives.length === 0) {
    return sentences.map((text) => ({ text, actions: [] }));
  }

  const beats: PerformanceBeat<T>[] = sentences.map((text) => ({
    text,
    actions: [] as T[],
  }));
  drives.forEach((action, i) => {
    const slot = Math.min(i, beats.length - 1);
    beats[slot].actions.push(action);
  });
  return beats;
}

export function isLiveAction<T extends { type: string }>(
  action: T | null | undefined
): action is T {
  return !!action && action.type !== "none";
}

/** Prefer `actions[]`; fall back to a single `action` for older payloads. */
export function normalizeTutorActions<T extends { type: string }>(data: {
  action?: T | null;
  actions?: T[] | null;
}): T[] {
  if (Array.isArray(data.actions) && data.actions.length > 0) {
    return data.actions.filter(isLiveAction);
  }
  return isLiveAction(data.action) ? [data.action] : [];
}
