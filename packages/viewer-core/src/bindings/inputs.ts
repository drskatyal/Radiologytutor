// Input specs: every key, mouse button, drag and wheel the viewer can bind,
// as one string grammar. Works with ANY mouse: no vendor SDK, just whatever
// the OS delivers (PointerEvent.button 0…n, wheel deltaX for tilt, and the
// F13–F24 / Ctrl+Alt combos that Razer / Logitech / Corsair / SteelSeries
// software emits for programmed buttons).
//
//   spec   = [Mod+][Ctrl+][Alt+][Shift+]token
//   token  = key        "R", "5", "F13", "ArrowUp", "Space", "PageDown", "]"
//          | MouseN      click of PointerEvent.button N (3 = back, 4 = forward, 5+ = extra)
//          | MouseNDrag  press-and-drag with button N
//          | Wheel       the vertical wheel (an axis: scroll / zoom / slab)
//          | WheelLeft | WheelRight   horizontal wheel / tilt (one step per notch)
//
// "Mod" is ⌘ on macOS and Ctrl elsewhere; "Ctrl" appears only on macOS.

export type InputKind = "key" | "click" | "drag" | "wheel" | "tilt";

export interface ModState {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface KeyLike extends ModState {
  key: string;
  code?: string;
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;

export interface ParsedSpec {
  mods: Set<string>;
  token: string;
}

export function parseSpec(spec: string): ParsedSpec {
  const parts = spec.split("+");
  // A trailing "+" is the plus key itself ("Mod++").
  let token = parts.pop() ?? "";
  if (token === "" && parts.length && parts[parts.length - 1] === "") {
    parts.pop();
    token = "+";
  }
  return { mods: new Set(parts.filter(Boolean)), token };
}

/** Canonical form: modifiers in a fixed order, letters upper-case. */
export function normalizeSpec(spec: string): string {
  const { mods, token } = parseSpec(spec.trim());
  const t = token.length === 1 ? token.toUpperCase() : token;
  return [...MOD_ORDER.filter((m) => mods.has(m)), t].join("+");
}

const MOUSE_RE = /^Mouse(\d{1,2})(Drag)?$/;

export function inputKind(spec: string): InputKind {
  const { token } = parseSpec(spec);
  const m = MOUSE_RE.exec(token);
  if (m) return m[2] ? "drag" : "click";
  if (token === "Wheel") return "wheel";
  if (token === "WheelLeft" || token === "WheelRight") return "tilt";
  return "key";
}

/** Button of a MouseN / MouseNDrag spec. */
export function mouseButtonOf(spec: string): number | null {
  const m = MOUSE_RE.exec(parseSpec(spec).token);
  return m ? Number(m[1]) : null;
}

/** Is this a spec the grammar accepts (used to validate imported files)? */
export function isValidSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || !spec || spec.length > 40) return false;
  const { mods, token } = parseSpec(spec);
  if (!token) return false;
  for (const m of mods) if (!(MOD_ORDER as readonly string[]).includes(m)) return false;
  const mouse = MOUSE_RE.exec(token);
  if (mouse) return Number(mouse[1]) <= 31;
  return /^[\x21-\x7e]$/.test(token) || /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(token);
}

function modsOf(e: ModState, mac: boolean): string[] {
  const mod = mac ? !!e.metaKey : !!e.ctrlKey;
  return [mod && "Mod", mac && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean) as string[];
}

const NAMED: Record<string, string> = { " ": "Space", Esc: "Escape", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Fn", "FnLock", "Hyper", "Super"]);

/**
 * The key part of a spec for a keyboard event: "K", "5", "ArrowUp", "F13",
 * "Space", "]". Letters and digits come from `code` (layout- and Shift-proof);
 * F13–F24 and other named keys from `key`, falling back to `code` when a
 * driver reports "Unidentified" (some mouse utilities do).
 */
export function keyTokenOf(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.code?.startsWith("Digit")) return e.code.slice(5);
  if (e.code?.startsWith("Key") && e.code.length === 4) return e.code.slice(3);
  if (e.code && /^F\d{1,2}$/.test(e.code)) return e.code;
  if ((!e.key || e.key === "Unidentified") && e.code) return e.code;
  if (!e.key || e.key === "Unidentified" || e.key === "Dead") return null;
  const k = NAMED[e.key] ?? e.key;
  return k.length === 1 ? k.toUpperCase() : k;
}

/** A keydown as a spec (null while only modifiers are held). */
export function keySpecOf(e: KeyLike, mac = isMac()): string | null {
  const token = keyTokenOf(e);
  if (!token) return null;
  return [...modsOf(e, mac), token].join("+");
}

/** A mouse click or drag with `button` as a spec. */
export function mouseSpecOf(button: number, gesture: "click" | "drag", e: ModState = {}, mac = isMac()): string {
  return [...modsOf(e, mac), `Mouse${button}${gesture === "drag" ? "Drag" : ""}`].join("+");
}

/** The vertical wheel (axis) with the held modifiers. */
export function wheelSpecOf(e: ModState = {}, mac = isMac()): string {
  return [...modsOf(e, mac), "Wheel"].join("+");
}

/** A horizontal wheel / tilt notch, or null for a vertical one. */
export function tiltSpecOf(e: ModState & { deltaX: number; deltaY: number }, mac = isMac()): string | null {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.deltaX === 0) return null;
  // Browsers turn Shift+wheel into deltaX; that stays the vertical wheel
  // (Shift+tilt is therefore not distinguishable, and not offered).
  if (e.shiftKey) return null;
  return [...modsOf(e, mac), e.deltaX < 0 ? "WheelLeft" : "WheelRight"].join("+");
}

/** Same spec? (canonical comparison). */
export function sameSpec(a: string, b: string): boolean {
  return normalizeSpec(a) === normalizeSpec(b);
}

/**
 * A spec (or a display string such as "R / Shift+R") in the platform's words:
 * ⌘ ⇧ ⌥ ⌫ on macOS, "Ctrl+Shift+M" elsewhere. Windows and Linux UI fonts lack
 * ⇧ / ⌥ / ⌫, which would render as "?".
 */
export function keyLabel(spec: string, mac = isMac()): string {
  return spec
    .replace(/Mod\+/g, mac ? "⌘" : "Ctrl+")
    .replace(/Ctrl\+/g, mac ? "⌃" : "Ctrl+")
    .replace(/Alt\+/g, mac ? "⌥" : "Alt+")
    .replace(/Shift\+/g, mac ? "⇧" : "Shift+")
    .replace(/Backspace/g, mac ? "⌫" : "Backspace");
}

/** "Mouse 4 (back)", "Mouse button 6", "Right": the name of a mouse button. */
export function mouseButtonName(button: number): string {
  switch (button) {
    case 0:
      return "Left";
    case 1:
      return "Middle";
    case 2:
      return "Right";
    case 3:
      return "Mouse 4 (back)";
    case 4:
      return "Mouse 5 (forward)";
    default:
      return `Mouse button ${button + 1}`;
  }
}

const TOKEN_WORDS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Delete: "Del",
  Escape: "Esc",
  Wheel: "Wheel",
  WheelLeft: "Wheel tilt left",
  WheelRight: "Wheel tilt right",
};

/**
 * Human label for any spec: "Ctrl+Shift+R", "F13", "Right drag",
 * "Ctrl+Right drag", "Mouse button 6", "Wheel tilt left", "Ctrl+Wheel".
 */
export function inputLabel(spec: string, mac = isMac()): string {
  const { mods, token } = parseSpec(spec);
  const prefix = keyLabel(MOD_ORDER.filter((m) => mods.has(m)).map((m) => `${m}+`).join(""), mac);
  const mouse = MOUSE_RE.exec(token);
  if (mouse) {
    const name = mouseButtonName(Number(mouse[1]));
    if (mouse[2]) return `${prefix}${name} drag`;
    return `${prefix}${Number(mouse[1]) <= 2 ? `${name} click` : name}`;
  }
  return `${prefix}${TOKEN_WORDS[token] ?? token}`;
}

/** Does this keyboard event press `spec`? */
export function keyMatches(spec: string, e: KeyLike, mac = isMac()): boolean {
  if (inputKind(spec) !== "key") return false;
  const got = keySpecOf(e, mac);
  return !!got && sameSpec(got, spec);
}
