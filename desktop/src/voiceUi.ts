// Voice commands in the UI: the command list for the help sheet and Settings
// (generated from the recognizer's own table, so it cannot drift from what is
// recognised), how voice is switched on, and when the loading card shows.

import { VOICE_COMMANDS, type VoiceAction } from "@flowrad/viewer-core";
import type { VoiceProgress, VoiceState } from "@flowrad/viewer-core";

export type VoiceGroup = "Navigate" | "Tools" | "View" | "Layout" | "Window presets" | "MPR and 3D" | "Voice";

const GROUP_OF: Record<VoiceAction["type"], VoiceGroup> = {
  series: "Navigate",
  slice: "Navigate",
  page: "Navigate",
  tool: "Tools",
  zoom: "View",
  reset: "View",
  invert: "View",
  layout: "Layout",
  preset: "Window presets",
  mpr: "MPR and 3D",
  volume3d: "MPR and 3D",
  slab: "MPR and 3D",
  slabThickness: "MPR and 3D",
  stop: "Voice",
};

export const VOICE_GROUP_ORDER: readonly VoiceGroup[] = ["Navigate", "Tools", "View", "Layout", "Window presets", "MPR and 3D", "Voice"];

export interface VoiceCommandRow {
  group: VoiceGroup;
  label: string;
  /** What to say: the first phrase is the main one, the rest are alternatives. */
  phrases: readonly string[];
}

/** Every voice command, grouped, in the recognizer table's order within each group. */
export function voiceCommandRows(): VoiceCommandRow[] {
  const rows = VOICE_COMMANDS.map((c) => ({ group: GROUP_OF[c.action.type], label: c.label, phrases: c.phrases }));
  return VOICE_GROUP_ORDER.flatMap((g) => rows.filter((r) => r.group === g));
}

/** The phrase that switches voice off, from the table. */
export function stopPhrase(): string {
  return VOICE_COMMANDS.find((c) => c.action.type === "stop")?.phrases[0] ?? "stop listening";
}

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
