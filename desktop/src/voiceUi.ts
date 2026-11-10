// Voice commands in the UI: the command list for the help sheet and Settings
// (generated from the recognizer's own table, so it cannot drift from what is
// recognised), how voice is switched on, and when the loading card shows.

import { stopPhrase } from "@flowrad/viewer-core";
import type { VoiceProgress, VoiceState } from "@flowrad/viewer-core";

// The grouped command list lives in the viewer core, shared with the web
// viewer's Voice commands sheet.
export { VOICE_GROUP_ORDER, stopPhrase, voiceCommandRows, type VoiceCommandRow, type VoiceGroup } from "@flowrad/viewer-core";

/**
 * How voice is switched on: the toolbar mic, or its key (`keys`, from the
 * bindings; none when the reader unbound it). A toggle, not push-to-talk.
 */
export function voiceTriggerText(keys?: string): string {
  const how = keys ? `the mic button in the toolbar or ${keys}` : "the mic button in the toolbar";
  return `Switch voice on and off with ${how}. It is a toggle, not push-to-talk: once on it keeps listening until you switch it off or say “${stopPhrase()}”.`;
}

/** No loading card for a load this short: most loads finish before anyone notices. */
export const VOICE_PROGRESS_DELAY_MS = 1_000;

/**
 * Show the voice status card? Always for an error (with Retry). While
 * loading, only after VOICE_PROGRESS_DELAY_MS, and only the first time the
 * model is prepared on this computer (`firstLoad`) — or when the microphone
 * permission prompt is what is being waited for. Switching voice on again
 * later just turns it on: the mic button shows it is starting.
 */
export function voiceStatusShown(opts: { state: VoiceState; slow: boolean; firstLoad: boolean; stage?: VoiceProgress["stage"] }): boolean {
  if (opts.state === "error") return true;
  if (opts.state !== "loading" || !opts.slow) return false;
  return opts.firstLoad || opts.stage === "permission";
}
