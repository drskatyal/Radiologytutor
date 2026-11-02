/**
 * Offline voice commands: a fixed grammar of short phrases and their actions.
 *
 * The recognizer is constrained to exactly these phrases (plus "[unk]" for
 * everything else), which keeps a small on-device model accurate and fast.
 * Phrases use plain spoken English; letters are spelled ("m p r") because
 * acronyms are not words in the model's vocabulary. Unknown words in the
 * grammar are ignored by the recognizer, so alternatives are cheap.
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

/** Every phrase the recognizer may return, with its action. */
export const VOICE_COMMANDS: readonly { phrases: readonly string[]; action: VoiceAction; label: string }[] = [
  { label: "Next series", phrases: ["next series"], action: { type: "series", delta: 1 } },
  { label: "Previous series", phrases: ["previous series", "last series", "back series"], action: { type: "series", delta: -1 } },
  { label: "Next slice", phrases: ["next slice", "next image", "scroll down", "down"], action: { type: "slice", delta: 1 } },
  { label: "Previous slice", phrases: ["previous slice", "previous image", "scroll up", "up"], action: { type: "slice", delta: -1 } },
  { label: "Page down", phrases: ["page down"], action: { type: "page", dir: 1 } },
  { label: "Page up", phrases: ["page up"], action: { type: "page", dir: -1 } },
  { label: "Zoom in", phrases: ["zoom in"], action: { type: "zoom", factor: 1.25 } },
  { label: "Zoom out", phrases: ["zoom out"], action: { type: "zoom", factor: 0.8 } },
  { label: "Zoom tool", phrases: ["zoom"], action: { type: "tool", tool: "Zoom" } },
  { label: "Pan", phrases: ["pan", "move"], action: { type: "tool", tool: "Pan" } },
  { label: "Window / level", phrases: ["window level", "window", "contrast"], action: { type: "tool", tool: "WindowLevel" } },
  { label: "Scroll tool", phrases: ["scroll", "browse"], action: { type: "tool", tool: "StackScroll" } },
  { label: "Measure", phrases: ["measure", "length", "ruler"], action: { type: "tool", tool: "Length" } },
  { label: "Ellipse", phrases: ["ellipse", "circle", "region"], action: { type: "tool", tool: "EllipticalROI" } },
  { label: "Angle", phrases: ["angle"], action: { type: "tool", tool: "Angle" } },
  { label: "Arrow", phrases: ["arrow", "pointer"], action: { type: "tool", tool: "ArrowAnnotate" } },
  { label: "Reset", phrases: ["reset"], action: { type: "reset" } },
  { label: "Invert", phrases: ["invert"], action: { type: "invert" } },
  { label: "MPR", phrases: ["m p r", "multi planar", "reformat"], action: { type: "mpr" } },
  { label: "3D", phrases: ["three d", "volume", "three dimensional"], action: { type: "volume3d" } },
  { label: "MIP", phrases: ["m i p", "maximum", "maximum intensity"], action: { type: "slab", mode: "mip" } },
  { label: "MinIP", phrases: ["min i p", "minimum", "minimum intensity"], action: { type: "slab", mode: "minip" } },
  { label: "Slab off", phrases: ["single slice", "slab off"], action: { type: "slab", mode: "off" } },
  { label: "Thicker", phrases: ["thicker"], action: { type: "slabThickness", deltaMm: 5 } },
  { label: "Thinner", phrases: ["thinner"], action: { type: "slabThickness", deltaMm: -5 } },
  { label: "Layout one", phrases: ["layout one", "one up", "single"], action: { type: "layout", rows: 1, cols: 1 } },
  { label: "Layout two", phrases: ["layout two", "two up", "side by side"], action: { type: "layout", rows: 1, cols: 2 } },
  { label: "Layout four", phrases: ["layout four", "four up", "grid"], action: { type: "layout", rows: 2, cols: 2 } },
  { label: "Lung window", phrases: ["lung window", "lung", "lungs"], action: { type: "preset", name: "lung" } },
  { label: "Bone window", phrases: ["bone window", "bone", "bones"], action: { type: "preset", name: "bone" } },
  { label: "Brain window", phrases: ["brain window", "brain"], action: { type: "preset", name: "brain" } },
  { label: "Abdomen window", phrases: ["abdomen window", "abdomen", "soft tissue"], action: { type: "preset", name: "abdomen" } },
  { label: "Stop listening", phrases: ["stop listening", "voice off"], action: { type: "stop" } },
];

const BY_PHRASE = new Map<string, VoiceAction>();
for (const c of VOICE_COMMANDS) for (const p of c.phrases) BY_PHRASE.set(p, c.action);

/** The recognizer grammar (JSON array of phrases, "[unk]" catches the rest). */
export function voiceGrammar(): string[] {
  return [...BY_PHRASE.keys(), "[unk]"];
}

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[unk\]/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The action for a recognized utterance, or null. Exact phrase first; then
 * the longest known phrase inside the utterance ("uh next series please").
 */
export function parseVoiceCommand(text: string): VoiceAction | null {
  const said = normalizeUtterance(text);
  if (!said) return null;
  const exact = BY_PHRASE.get(said);
  if (exact) return exact;
  let best: { phrase: string; action: VoiceAction } | null = null;
  for (const [phrase, action] of BY_PHRASE) {
    if ((` ${said} `).includes(` ${phrase} `) && (!best || phrase.length > best.phrase.length)) best = { phrase, action };
  }
  return best?.action ?? null;
}

/** For the help sheet: one row per command with its phrases. */
export function voiceCommandSheet(): { label: string; say: string }[] {
  return VOICE_COMMANDS.map((c) => ({ label: c.label, say: c.phrases.map((p) => `“${p}”`).join(" · ") }));
}
