/**
 * Offline voice commands: a fixed grammar of short phrases and their actions.
 *
 * The recognizer is constrained to exactly these phrases (plus "[unk]" for
 * everything else), which keeps a small on-device model accurate and fast.
 * Phrases use plain spoken English; letters are spelled ("m p r") because
 * acronyms are not words in the model's vocabulary. Unknown words in the
 * grammar are ignored by the recognizer, so alternatives are cheap.
 *
 * Every phrase is at least two words and only a whole utterance matches, so
 * a lone word ("bone") or a command inside dictation ("the lung window looks
 * fine") never fires anything. The help sheet and Settings list these exact
 * phrases from this table.
 *
 * Pure: the app maps `VoiceAction` onto its own action handlers.
 */

export type VoiceTool = "StackScroll" | "WindowLevel" | "Zoom" | "Pan" | "Length" | "EllipticalROI" | "Angle" | "ArrowAnnotate";

export type VoiceAction =
  | { type: "series"; delta: 1 | -1 }
  | { type: "slice"; delta: number }
  | { type: "page"; dir: 1 | -1 }
  | { type: "zoom"; factor: number }
  | { type: "tool"; tool: VoiceTool }
  | { type: "reset" }
  | { type: "invert" }
  | { type: "mpr" }
  | { type: "volume3d" }
  | { type: "slab"; mode: "mip" | "minip" | "off" }
  | { type: "slabThickness"; deltaMm: number }
  | { type: "layout"; rows: number; cols: number }
  | { type: "preset"; name: "lung" | "bone" | "brain" | "abdomen" }
  | { type: "stop" };

/**
 * Every phrase the recognizer may return, with its action. Each phrase is two
 * or more words ("bone window", never "bone") and only the WHOLE utterance
 * matches (parseVoiceCommand), so dictation or conversation that happens to
 * contain a command word never fires one.
 */
export const VOICE_COMMANDS: readonly { phrases: readonly string[]; action: VoiceAction; label: string }[] = [
  { label: "Next series", phrases: ["next series"], action: { type: "series", delta: 1 } },
  { label: "Previous series", phrases: ["previous series", "last series"], action: { type: "series", delta: -1 } },
  { label: "Next slice", phrases: ["next slice", "next image", "scroll down"], action: { type: "slice", delta: 1 } },
  { label: "Previous slice", phrases: ["previous slice", "previous image", "scroll up"], action: { type: "slice", delta: -1 } },
  { label: "Page down", phrases: ["page down"], action: { type: "page", dir: 1 } },
  { label: "Page up", phrases: ["page up"], action: { type: "page", dir: -1 } },
  { label: "Zoom in", phrases: ["zoom in"], action: { type: "zoom", factor: 1.25 } },
  { label: "Zoom out", phrases: ["zoom out"], action: { type: "zoom", factor: 0.8 } },
  { label: "Zoom tool", phrases: ["zoom tool"], action: { type: "tool", tool: "Zoom" } },
  { label: "Pan", phrases: ["pan tool", "move tool"], action: { type: "tool", tool: "Pan" } },
  { label: "Window / level", phrases: ["window level", "contrast tool"], action: { type: "tool", tool: "WindowLevel" } },
  { label: "Scroll tool", phrases: ["scroll tool", "browse tool"], action: { type: "tool", tool: "StackScroll" } },
  { label: "Measure", phrases: ["measure tool", "length tool", "ruler tool"], action: { type: "tool", tool: "Length" } },
  { label: "Ellipse", phrases: ["ellipse tool", "circle tool"], action: { type: "tool", tool: "EllipticalROI" } },
  { label: "Angle", phrases: ["angle tool"], action: { type: "tool", tool: "Angle" } },
  { label: "Arrow", phrases: ["arrow tool", "pointer tool"], action: { type: "tool", tool: "ArrowAnnotate" } },
  { label: "Reset view", phrases: ["reset view"], action: { type: "reset" } },
  { label: "Invert", phrases: ["invert image", "invert colors"], action: { type: "invert" } },
  { label: "MPR", phrases: ["m p r", "multi planar"], action: { type: "mpr" } },
  { label: "3D", phrases: ["three d", "three dimensional", "volume rendering"], action: { type: "volume3d" } },
  { label: "MIP", phrases: ["m i p", "maximum intensity"], action: { type: "slab", mode: "mip" } },
  { label: "MinIP", phrases: ["min i p", "minimum intensity"], action: { type: "slab", mode: "minip" } },
  { label: "Slab off", phrases: ["single slice", "slab off"], action: { type: "slab", mode: "off" } },
  { label: "Thicker slab", phrases: ["thicker slab"], action: { type: "slabThickness", deltaMm: 5 } },
  { label: "Thinner slab", phrases: ["thinner slab"], action: { type: "slabThickness", deltaMm: -5 } },
  { label: "Layout one", phrases: ["layout one", "one up"], action: { type: "layout", rows: 1, cols: 1 } },
  { label: "Layout two", phrases: ["layout two", "two up", "side by side"], action: { type: "layout", rows: 1, cols: 2 } },
  { label: "Layout four", phrases: ["layout four", "four up"], action: { type: "layout", rows: 2, cols: 2 } },
  { label: "Lung window", phrases: ["lung window"], action: { type: "preset", name: "lung" } },
  { label: "Bone window", phrases: ["bone window"], action: { type: "preset", name: "bone" } },
  { label: "Brain window", phrases: ["brain window"], action: { type: "preset", name: "brain" } },
  { label: "Abdomen window", phrases: ["abdomen window", "soft tissue window"], action: { type: "preset", name: "abdomen" } },
  { label: "Stop listening", phrases: ["stop listening", "voice off"], action: { type: "stop" } },
];

/** Words in a command phrase: never fewer (a lone word is too easy to say by accident). */
export const MIN_PHRASE_WORDS = 2;

const BY_PHRASE = new Map<string, VoiceAction>();
for (const c of VOICE_COMMANDS) for (const p of c.phrases) BY_PHRASE.set(p, c.action);

/**
 * The recognizer grammar (Vosk / Kaldi: a list of whole-utterance
 * alternatives). "[unk]" is the garbage path: speech that is not one of the
 * phrases comes back as "[unk]" instead of being forced onto a command.
 */
export function voiceGrammar(): string[] {
  return [...BY_PHRASE.keys(), "[unk]"];
}

/** Case and spacing only: "  Lung   Window " → "lung window". Words (and "[unk]") are kept. */
export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The action for a recognized utterance, or null. Only an utterance that IS a
 * command phrase matches (allowing for case and surrounding whitespace): a
 * single word, or a phrase inside longer speech ("[unk] lung window", "the
 * lung window looks fine"), fires nothing.
 */
export function parseVoiceCommand(text: string): VoiceAction | null {
  const said = normalizeUtterance(text);
  if (!said) return null;
  return BY_PHRASE.get(said) ?? null;
}

/** For the help sheet: one row per command with its phrases. */
export function voiceCommandSheet(): { label: string; say: string }[] {
  return VOICE_COMMANDS.map((c) => ({ label: c.label, say: c.phrases.map((p) => `“${p}”`).join(" · ") }));
}

// ── Grouped list for help sheets (web and desktop) ──────────────────────────

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

