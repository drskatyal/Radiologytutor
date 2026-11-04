// FlowRad Viewer plugin host: the extension point, and nothing else.
//
// Plugins live in a SEPARATE repository and are OFF by default. This module
// defines the contract a plugin codes against and the host that runs them:
//
//   • commands  — open a plane (axial / coronal / sagittal / 3D MPR), scroll,
//                 window presets, zoom, next series, take a key image
//   • state     — read-only study / series / slice (+ view mode), with subscribe
//   • ui        — one panel element in the right-side plugin panel (icon tab rail)
//   • overlay   — a layer over the viewport (pointer-events off by default)
//   • input     — hotkeys (Alt+Shift+<key> only, so a plugin can never take a
//                 core shortcut) and a mic action (press / release hook; the
//                 plugin captures audio itself, behind the browser's prompt)
//
// No framework, no app imports (viewer-core boundary): the web viewer and the
// desktop app can both host it. Every input from a plugin is validated here;
// a plugin that throws is isolated (logged, its panel shows the error) and
// never breaks the viewer. 3D MPR is part of the FREE core: plugins may ask
// for it but never gate it.

export const PLUGIN_API_VERSION = 1 as const;

export type ViewerPlane = "axial" | "coronal" | "sagittal" | "mpr3d";
export type WindowPresetName = "lung" | "bone" | "brain" | "abdomen";
export const VIEWER_PLANES: readonly ViewerPlane[] = ["axial", "coronal", "sagittal", "mpr3d"];
export const WINDOW_PRESET_NAMES: readonly WindowPresetName[] = ["lung", "bone", "brain", "abdomen"];

export type ViewerCommand =
  | { type: "openPlane"; plane: ViewerPlane }
  | { type: "scroll"; delta: number }
  | { type: "windowPreset"; preset: WindowPresetName }
  | { type: "zoom"; factor: number }
  | { type: "nextSeries"; delta: 1 | -1 }
  | { type: "takeKeyImage" };

export interface KeyImage {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  /** 0-based slice in the series on screen. */
  sliceIndex?: number;
  /** Pixels only, no overlay text. */
  mimeType: string;
  base64: string;
}

export type ViewerCommandResult = { ok: true; keyImage?: KeyImage; note?: string } | { ok: false; reason: string };

/** Validate an untrusted command from a plugin. A string is the reason it was refused. */
export function parseViewerCommand(raw: unknown): ViewerCommand | string {
  if (!raw || typeof raw !== "object") return "A command must be an object.";
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case "openPlane":
      return VIEWER_PLANES.includes(c.plane as ViewerPlane) ? { type: "openPlane", plane: c.plane as ViewerPlane } : `Unknown plane: ${String(c.plane)}`;
    case "scroll": {
      const d = Number(c.delta);
      return Number.isInteger(d) && d !== 0 && Math.abs(d) <= 10_000 ? { type: "scroll", delta: d } : "scroll needs a non-zero whole number delta.";
    }
    case "windowPreset":
      return WINDOW_PRESET_NAMES.includes(c.preset as WindowPresetName)
        ? { type: "windowPreset", preset: c.preset as WindowPresetName }
        : `Unknown window preset: ${String(c.preset)}`;
    case "zoom": {
      const f = Number(c.factor);
      return Number.isFinite(f) && f >= 0.1 && f <= 10 && f !== 1 ? { type: "zoom", factor: f } : "zoom needs a factor between 0.1 and 10 (not 1).";
    }
    case "nextSeries":
      return { type: "nextSeries", delta: c.delta === -1 ? -1 : 1 };
    case "takeKeyImage":
      return { type: "takeKeyImage" };
    default:
      return `Unknown command: ${String(c.type)}`;
  }
}

// ---------------------------------------------------------------------------
// Read-only viewer state
// ---------------------------------------------------------------------------

export interface ViewerStateSnapshot {
  study: { studyInstanceUID?: string; description?: string; seriesCount: number } | null;
  series: { seriesInstanceUID?: string; description?: string; modality?: string; index: number; imageCount: number } | null;
  slice: { index: number; count: number } | null;
  mode: "stack" | "mpr" | "3d";
}

export const EMPTY_VIEWER_STATE: ViewerStateSnapshot = Object.freeze({ study: null, series: null, slice: null, mode: "stack" }) as ViewerStateSnapshot;

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};

// ---------------------------------------------------------------------------
// Hotkeys: Alt+Shift+<key> only (never a core shortcut)
// ---------------------------------------------------------------------------

export interface PluginHotkey {
  /** Lower-case key, e.g. "k", "1", "f2". */
  key: string;
}

/** "Alt+Shift+K" → { key: "k" }. Anything without exactly Alt+Shift is refused. */
export function parsePluginHotkey(combo: string): PluginHotkey | string {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  const key = parts.at(-1) ?? "";
  if (mods.size !== 2 || !mods.has("alt") || !mods.has("shift")) {
    return "Plugin hotkeys must be Alt+Shift+<key>, so they never take a viewer shortcut.";
  }
  if (!/^([a-z0-9]|f([1-9]|1[0-2]))$/.test(key)) return `Unsupported hotkey key: ${key}`;
  return { key };
}

export interface PluginKeyLike {
  key: string;
  code?: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

/** The plugin hotkey a key event would trigger (layout-proof: uses `code` for letters/digits). */
export function hotkeyOf(e: PluginKeyLike): string | null {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
  const code = e.code ?? "";
  const m = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!.toLowerCase();
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return e.key.length === 1 ? e.key.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

export interface MicAction {
  label: string;
  /** Optional hold-to-talk hotkey (Alt+Shift+<key>). */
  hotkey?: string;
  onStart: () => void;
  onStop: () => void;
}

export interface PluginContext {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  commands: {
    run(command: ViewerCommand): Promise<ViewerCommandResult>;
    openPlane(plane: ViewerPlane): Promise<ViewerCommandResult>;
    scroll(delta: number): Promise<ViewerCommandResult>;
    windowPreset(preset: WindowPresetName): Promise<ViewerCommandResult>;
    zoom(factor: number): Promise<ViewerCommandResult>;
    nextSeries(delta?: 1 | -1): Promise<ViewerCommandResult>;
    takeKeyImage(): Promise<ViewerCommandResult>;
  };
  state: {
    get(): ViewerStateSnapshot;
    subscribe(listener: (state: ViewerStateSnapshot) => void): () => void;
  };
  ui: {
    /** This plugin's panel body in the right-side plugin panel. */
    panel: HTMLElement;
  };
  overlay: {
    /** A layer over the viewport; pointer-events off unless `interactive`. */
    create(options?: { interactive?: boolean }): HTMLElement;
  };
  input: {
    registerHotkey(combo: string, handler: () => void): () => void;
    registerMicAction(action: MicAction): () => void;
  };
}

export interface FlowradViewerPlugin {
  id: string;
  name: string;
  apiVersion: number;
  /** One or two characters for the tab rail, or an https/data: image URL. */
  icon?: string;
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Validate a loaded module's default export. A string is the reason it was refused. */
export function validatePlugin(value: unknown): FlowradViewerPlugin | string {
  if (!value || typeof value !== "object") return "The module's default export is not a plugin object.";
  const p = value as Partial<FlowradViewerPlugin>;
  if (typeof p.id !== "string" || !ID_RE.test(p.id)) return "Plugin id must be 2–40 lower-case letters, digits or dashes.";
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 60) return "Plugin name is missing or too long.";
  if (p.apiVersion !== PLUGIN_API_VERSION) return `Plugin needs API version ${String(p.apiVersion)}; this viewer provides ${PLUGIN_API_VERSION}.`;
  if (typeof p.activate !== "function") return "Plugin has no activate() function.";
  if (p.icon !== undefined && (typeof p.icon !== "string" || !(/^.{1,2}$/u.test(p.icon) || /^(https:|data:image\/)/.test(p.icon)))) {
    return "Plugin icon must be one or two characters or an image URL.";
  }
  return p as FlowradViewerPlugin;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface PluginEntry {
  id: string;
  name: string;
  icon?: string;
  status: "active" | "error";
  error?: string;
  panel: HTMLElement;
  micActions: MicAction[];
}

export interface PluginHostOptions {
  /** Executes a validated command in the viewer. */
  run: (command: ViewerCommand) => Promise<ViewerCommandResult>;
  /** The element overlays attach to (over the viewport). Null while no study is open. */
  overlayRoot: () => HTMLElement | null;
  /** Creates DOM nodes (the page's document; injectable for tests). */
  createElement: (tag: string) => HTMLElement;
  /** Called whenever the plugin list, a status or a mic action changes. */
  onChange?: () => void;
  log?: (message: string) => void;
}

export interface PluginHost {
  register(plugin: FlowradViewerPlugin): Promise<PluginEntry>;
  /** Record a plugin that failed to load (shown in its tab). */
  registerFailure(id: string, name: string, error: string): PluginEntry;
  entries(): PluginEntry[];
  setState(next: ViewerStateSnapshot): void;
  getState(): ViewerStateSnapshot;
  /** Route a keydown; true when a plugin hotkey handled it (caller should preventDefault). */
  handleKeyDown(e: PluginKeyLike): boolean;
  /** Route a keyup (ends hold-to-talk mic actions). */
  handleKeyUp(e: PluginKeyLike): boolean;
  dispose(): void;
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const entries = new Map<string, PluginEntry>();
  const disposers = new Map<string, (() => void)[]>();
  const stateListeners = new Set<(s: ViewerStateSnapshot) => void>();
  const hotkeys = new Map<string, { owner: string; handler: () => void }>();
  const micHotkeys = new Map<string, { owner: string; action: MicAction }>();
  const holding = new Set<string>();
  let state: ViewerStateSnapshot = EMPTY_VIEWER_STATE;
  const log = options.log ?? (() => undefined);
  const changed = () => options.onChange?.();

  const guard = (owner: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log(`plugin ${owner}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fail = (id: string, error: string) => {
    const e = entries.get(id);
    if (e) {
      e.status = "error";
      e.error = error;
      changed();
    }
  };

  const contextFor = (entry: PluginEntry): PluginContext => {
    const owned = (): (() => void)[] => disposers.get(entry.id) ?? [];
    const run = async (command: unknown): Promise<ViewerCommandResult> => {
      const parsed = parseViewerCommand(command);
      if (typeof parsed === "string") return { ok: false, reason: parsed };
      try {
        return await options.run(parsed);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "The viewer could not run that command." };
      }
    };
    return {
      apiVersion: PLUGIN_API_VERSION,
      commands: {
        run,
        openPlane: (plane) => run({ type: "openPlane", plane }),
        scroll: (delta) => run({ type: "scroll", delta }),
        windowPreset: (preset) => run({ type: "windowPreset", preset }),
        zoom: (factor) => run({ type: "zoom", factor }),
        nextSeries: (delta = 1) => run({ type: "nextSeries", delta }),
        takeKeyImage: () => run({ type: "takeKeyImage" }),
      },
      state: {
        get: () => state,
        subscribe: (listener) => {
          const wrapped = (s: ViewerStateSnapshot) => guard(entry.id, () => listener(s));
          stateListeners.add(wrapped);
          const off = () => stateListeners.delete(wrapped);
          owned().push(off);
          return off;
        },
      },
      ui: { panel: entry.panel },
      overlay: {
        create: (opts) => {
          const root = options.overlayRoot();
          if (!root) throw new Error("No viewport is open yet; create overlays after state.series is set.");
          const layer = options.createElement("div");
          layer.dataset.flowradPlugin = entry.id;
          layer.style.position = "absolute";
          layer.style.inset = "0";
          layer.style.pointerEvents = opts?.interactive ? "auto" : "none";
          root.appendChild(layer);
          owned().push(() => layer.remove());
          return layer;
        },
      },
      input: {
        registerHotkey: (combo, handler) => {
          const hk = parsePluginHotkey(combo);
          if (typeof hk === "string") throw new Error(hk);
          if (hotkeys.has(hk.key) || micHotkeys.has(hk.key)) throw new Error(`Alt+Shift+${hk.key.toUpperCase()} is already used by another plugin.`);
          hotkeys.set(hk.key, { owner: entry.id, handler });
          const off = () => {
            if (hotkeys.get(hk.key)?.owner === entry.id) hotkeys.delete(hk.key);
          };
          owned().push(off);
          return off;
        },
        registerMicAction: (action) => {
          if (!action || typeof action.onStart !== "function" || typeof action.onStop !== "function" || typeof action.label !== "string") {
            throw new Error("A mic action needs label, onStart and onStop.");
          }
          let key: string | null = null;
          if (action.hotkey) {
            const hk = parsePluginHotkey(action.hotkey);
            if (typeof hk === "string") throw new Error(hk);
            if (hotkeys.has(hk.key) || micHotkeys.has(hk.key)) throw new Error(`Alt+Shift+${hk.key.toUpperCase()} is already used by another plugin.`);
            key = hk.key;
            micHotkeys.set(key, { owner: entry.id, action });
          }
          entry.micActions.push(action);
          changed();
          const off = () => {
            entry.micActions = entry.micActions.filter((a) => a !== action);
            if (key && micHotkeys.get(key)?.owner === entry.id) micHotkeys.delete(key);
            changed();
          };
          owned().push(off);
          return off;
        },
      },
    };
  };

  return {
    async register(plugin) {
      const ok = validatePlugin(plugin);
      if (typeof ok === "string") throw new Error(ok);
      if (entries.has(ok.id)) throw new Error(`A plugin with id "${ok.id}" is already loaded.`);
      const panel = options.createElement("div");
      panel.dataset.flowradPluginPanel = ok.id;
      const entry: PluginEntry = { id: ok.id, name: ok.name, icon: ok.icon, status: "active", panel, micActions: [] };
      entries.set(ok.id, entry);
      disposers.set(ok.id, []);
      changed();
      try {
        const cleanup = await ok.activate(contextFor(entry));
        if (typeof cleanup === "function") disposers.get(ok.id)!.push(cleanup);
      } catch (err) {
        fail(ok.id, err instanceof Error ? err.message : "The plugin failed to start.");
      }
      return entry;
    },
    registerFailure(id, name, error) {
      const entry: PluginEntry = { id, name, status: "error", error, panel: options.createElement("div"), micActions: [] };
      entries.set(id, entry);
      changed();
      return entry;
    },
    entries: () => [...entries.values()],
    setState(next) {
      state = deepFreeze(structuredCloneSafe(next));
      for (const l of stateListeners) l(state);
    },
    getState: () => state,
    handleKeyDown(e) {
      const key = hotkeyOf(e);
      if (!key) return false;
      const hk = hotkeys.get(key);
      if (hk) {
        if (!e.repeat) guard(hk.owner, hk.handler);
        return true;
      }
      const mic = micHotkeys.get(key);
      if (mic) {
        if (!holding.has(key)) {
          holding.add(key);
          guard(mic.owner, mic.action.onStart);
        }
        return true;
      }
      return false;
    },
    handleKeyUp(e) {
      // Release on the key alone: the reader may lift Alt/Shift first.
      for (const key of holding) {
        const code = e.code ?? "";
        const released = code === `Key${key.toUpperCase()}` || code === `Digit${key}` || code.toLowerCase() === key || e.key.toLowerCase() === key;
        if (!released) continue;
        holding.delete(key);
        const mic = micHotkeys.get(key);
        if (mic) guard(mic.owner, mic.action.onStop);
        return true;
      }
      return false;
    },
    dispose() {
      for (const [id, list] of disposers) for (const off of list.reverse()) guard(id, off);
      disposers.clear();
      entries.clear();
      hotkeys.clear();
      micHotkeys.clear();
      stateListeners.clear();
      holding.clear();
      changed();
    },
  };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
