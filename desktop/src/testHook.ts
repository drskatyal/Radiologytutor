// Bench / e2e test hook: `window.__flowradTest`, installed ONLY in bench or
// test mode (FLOWRAD_BENCH=1 in the desktop app, `?bench` in the browser
// build; the same gate as benchReport). It lets bench.mjs (`hooks` mode) and
// the UI e2e drive and verify, through the app's own APIs:
//
//   orientation  rotate / flip / reset on the active viewport through its
//                ViewportHandle (what the toolbar, keys and voice call), then
//                read back the state the viewport DREW: the readout follows the
//                rendered frame (Cornerstone IMAGE_RENDERED / CAMERA_MODIFIED,
//                or the native renderer's answer after it presented). Native
//                viewports are also asked Rust directly (native_cell_view).
//   thumbnails   the series browser's cards: one per listed series, each
//                rendered (an <img> with pixels, or a drawn canvas).
//   bindings     set a custom binding, check it resolves (live, and persisted
//                to settings), reset all (the Settings › Mouse & Keyboard
//                "Reset all" path: bindings = {}), check every command is back
//                on its preset. The reader's own bindings are restored after.
//
// Nothing here has its own logic for rotating, binding or thumbnailing: every
// action is the app's, and the hook only waits and compares.

import { assignInput, inputIndex, inputsFor, normalizeSpec, getLiveBindings, type BindingOverrides } from "@flowrad/viewer-core/bindings";
import { applyOrientation, normalizeRotation, IDENTITY_ORIENTATION, type ViewOrientation } from "@flowrad/viewer-core";
import { DESKTOP_COMMANDS } from "./shortcuts";
import { invoke, isTauri, settingsGet } from "./platform";
import type { ViewportHandle } from "./viewer/handles";
import { isNativeHandle } from "./viewer/handles";
import type { ViewerStudy } from "./types";

export interface TestHookDeps {
  /** The active viewport's handle and its cell key (the native renderer's cell id). */
  activeHandle(): ViewportHandle | undefined;
  activeCellKey(): string;
  studies(): ViewerStudy[];
  hiddenSeries(): ReadonlySet<string>;
  /** Series panel collapsed / compact rows (no thumbnails either way). */
  seriesPanel(): { collapsed: boolean; compact: boolean };
  openSeriesPanel(): void;
  bindings(): BindingOverrides;
  /** The app's settings update (Settings dialog → onChange). */
  updateBindings(next: BindingOverrides): void;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface OrientationState extends ViewOrientation {
  /** Rust's answer for a native viewport (what it last presented). */
  native?: ViewOrientation | null;
  renderPath: "native" | "engine";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<{ value: T; ok: boolean; ms: number }> {
  const t0 = performance.now();
  let value = await read();
  while (!ok(value) && performance.now() - t0 < timeoutMs) {
    await frame();
    value = await read();
  }
  return { value, ok: ok(value), ms: Math.round(performance.now() - t0) };
}

const sameOrientation = (a: ViewOrientation | null | undefined, b: ViewOrientation) =>
  !!a && a.rotation === b.rotation && !!a.flipH === b.flipH && !!a.flipV === b.flipV;

export function createTestHook(deps: TestHookDeps) {
  // ───────────── orientation ─────────────
  async function orientation(): Promise<OrientationState | null> {
    const h = deps.activeHandle();
    const r = h?.readout();
    if (!h || !r) return null;
    const native = isNativeHandle(h);
    const state: OrientationState = {
      rotation: r.rotation ?? 0,
      flipH: !!r.flipH,
      flipV: !!r.flipV,
      renderPath: native ? "native" : "engine",
    };
    if (native && isTauri) {
      const shown = await invoke<{ view: ViewOrientation }>("native_cell_view", { id: deps.activeCellKey(), patch: {} }).catch(() => null);
      state.native = shown ? { rotation: shown.view.rotation, flipH: !!shown.view.flipH, flipV: !!shown.view.flipV } : null;
    }
    return state;
  }

  /** Run one handle action and wait until the drawn state equals `expect`. */
  async function applyAndWait(act: (h: ViewportHandle) => void, expect: (before: OrientationState) => ViewOrientation, timeoutMs = 3000) {
    const before = await orientation();
    const h = deps.activeHandle();
    if (!before || !h) return { ok: false, before, after: null, expected: null, ms: 0, why: "no active viewport with an image" };
    const expected = expect(before);
    act(h);
    const res = await until(orientation, (s) => sameOrientation(s, expected) && (s?.native === undefined || sameOrientation(s.native, expected)), timeoutMs);
    return { ok: res.ok, before, after: res.value, expected, ms: res.ms };
  }

  const rotate = (degrees: number) =>
    applyAndWait((h) => h.rotate(degrees), (b) => ({ ...b, rotation: normalizeRotation(b.rotation + degrees) }));
  // Screen flips, as the app defines them (viewer-core viewOrientation.ts).
  const flip = (axis: "h" | "v") => applyAndWait((h) => h.flip(axis), (b) => applyOrientation(b, axis === "h" ? "flip:h" : "flip:v"));
  const resetOrientation = () => applyAndWait((h) => h.resetOrientation(), () => IDENTITY_ORIENTATION);

  async function checkOrientation(): Promise<{ ok: boolean; checks: Check[]; final: OrientationState | null }> {
    const checks: Check[] = [];
    const step = async (name: string, run: () => Promise<{ ok: boolean; after: OrientationState | null; expected: ViewOrientation | null; ms: number; why?: string }>) => {
      const r = await run();
      checks.push({ name, ok: r.ok, detail: r.why ?? `expected ${JSON.stringify(r.expected)} drew ${JSON.stringify(r.after)} in ${r.ms} ms` });
    };
    await step("orientation: reset to the file's orientation", resetOrientation);
    await step("orientation: rotate 90° clockwise", () => rotate(90));
    await step("orientation: rotate 90° again (180°)", () => rotate(90));
    await step("orientation: rotate 90° anticlockwise (90°)", () => rotate(-90));
    await step("orientation: back to 0°", () => rotate(-90));
    await step("orientation: flip horizontal", () => flip("h"));
    await step("orientation: flip vertical", () => flip("v"));
    await step("orientation: flip horizontal again (undone)", () => flip("h"));
    await step("orientation: reset orientation", resetOrientation);
    return { ok: checks.every((c) => c.ok), checks, final: await orientation() };
  }

  // ───────────── thumbnails ─────────────
  function thumbnailState() {
    const hidden = deps.hiddenSeries();
    const expected = deps.studies().flatMap((s) => s.series.filter((x) => !hidden.has(x.uid)).map((x) => x.uid));
    const cards = [...document.querySelectorAll<HTMLElement>("[data-thumbnail]")];
    const drawn = (el: HTMLElement) => {
      const img = el.querySelector("img");
      if (img) return img.complete && img.naturalWidth > 0;
      const canvas = el.querySelector("canvas");
      return !!canvas && el.dataset.thumbState === "ready";
    };
    const rendered = cards.filter((el) => el.dataset.thumbState === "ready" && drawn(el));
    const uids = new Set(cards.map((el) => el.dataset.thumbnail));
    return {
      expected: expected.length,
      cards: cards.length,
      rendered: rendered.length,
      failed: cards.filter((el) => el.dataset.thumbState === "error").map((el) => el.dataset.thumbnail),
      missing: expected.filter((uid) => !uids.has(uid)),
      pending: cards.filter((el) => !rendered.includes(el)).map((el) => el.dataset.thumbnail),
      ...deps.seriesPanel(),
    };
  }

  /** Wait for every thumbnail; cards out of view are scrolled in (they load lazily). */
  async function checkThumbnails(timeoutMs = 20_000): Promise<{ ok: boolean; checks: Check[]; state: ReturnType<typeof thumbnailState> }> {
    if (deps.seriesPanel().collapsed) {
      deps.openSeriesPanel();
      await wait(300);
    }
    const t0 = performance.now();
    let state = thumbnailState();
    while ((state.rendered < state.expected || state.cards !== state.expected) && performance.now() - t0 < timeoutMs) {
      const next = state.pending[0];
      if (next) document.querySelector(`[data-thumbnail="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
      await wait(100);
      state = thumbnailState();
    }
    const checks: Check[] = [
      { name: "thumbnails: one card per series in the study", ok: state.cards === state.expected && state.missing.length === 0, detail: `${state.cards} cards, ${state.expected} series${state.missing.length ? `, missing ${state.missing.join(", ")}` : ""}${state.compact ? " (compact rows: no thumbnails)" : ""}` },
      { name: "thumbnails: every card rendered", ok: state.expected > 0 && state.rendered === state.expected, detail: `${state.rendered} of ${state.expected} rendered${state.failed.length ? `, failed ${state.failed.join(", ")}` : ""}` },
    ];
    return { ok: checks.every((c) => c.ok), checks, state };
  }

  // ───────────── bindings ─────────────
  const commandFor = (spec: string) => inputIndex(DESKTOP_COMMANDS, getLiveBindings()).get(normalizeSpec(spec));
  const effective = (id: string) => inputsFor(DESKTOP_COMMANDS, getLiveBindings(), id);
  const persisted = async () => ((await settingsGet<{ bindings?: BindingOverrides }>()).bindings ?? {}) as BindingOverrides;
  const differsFromPreset = () =>
    DESKTOP_COMMANDS.filter((c) => {
      const now = effective(c.id).map(normalizeSpec);
      const def = c.defaults.map(normalizeSpec);
      return now.length !== def.length || now.some((s, i) => s !== def[i]);
    }).map((c) => c.id);

  const bindings = {
    get: () => ({ overrides: getLiveBindings(), saved: deps.bindings() }),
    commandFor,
    effective,
    persisted,
    /** Replace a command's inputs with `spec` (refuses a held input, like Settings). */
    async set(commandId: string, spec: string) {
      deps.updateBindings(assignInput(DESKTOP_COMMANDS, getLiveBindings(), commandId, spec));
      await frame();
      return { commandFor: commandFor(spec), effective: effective(commandId) };
    },
    /** Settings › Mouse & Keyboard › Reset all. */
    async reset() {
      deps.updateBindings({});
      await frame();
      return { overrides: getLiveBindings(), notPreset: differsFromPreset() };
    },
    differsFromPreset,
  };

  async function checkBindings(commandId = "slice.next", spec = "Alt+Shift+F9"): Promise<{ ok: boolean; checks: Check[] }> {
    const checks: Check[] = [];
    const original = getLiveBindings();
    const cmd = DESKTOP_COMMANDS.find((c) => c.id === commandId);
    if (!cmd) return { ok: false, checks: [{ name: `bindings: command ${commandId} exists`, ok: false }] };
    const preset = cmd.defaults.map(normalizeSpec);
    const target = normalizeSpec(spec);
    try {
      // Start from the preset so the check means the same on every machine.
      await bindings.reset();
      const free = commandFor(target);
      checks.push({ name: `bindings: ${target} is free in the preset`, ok: free == null, detail: free ? `held by ${free}` : "" });
      await bindings.set(commandId, target);
      checks.push({ name: `bindings: ${target} now runs ${commandId}`, ok: commandFor(target) === commandId, detail: `resolves to ${commandFor(target)}` });
      checks.push({ name: `bindings: ${commandId} has only the custom input`, ok: effective(commandId).map(normalizeSpec).join() === target, detail: effective(commandId).join(", ") });
      checks.push({ name: `bindings: the preset input ${preset[0]} no longer runs ${commandId}`, ok: commandFor(preset[0]) !== commandId, detail: `resolves to ${commandFor(preset[0])}` });
      const saved = await until(persisted, (p) => (p[commandId] ?? []).map(normalizeSpec).includes(target), 3000);
      checks.push({ name: "bindings: the custom binding is saved to settings", ok: saved.ok, detail: JSON.stringify(saved.value) });
      const after = await bindings.reset();
      checks.push({ name: "bindings: reset all leaves no overrides", ok: Object.keys(after.overrides).length === 0, detail: JSON.stringify(after.overrides) });
      checks.push({ name: "bindings: every command is back on its preset", ok: after.notPreset.length === 0, detail: after.notPreset.join(", ") });
      checks.push({ name: `bindings: ${preset[0]} runs ${commandId} again`, ok: preset.every((p) => commandFor(p) === commandId), detail: preset.map((p) => `${p} → ${commandFor(p)}`).join(", ") });
      checks.push({ name: `bindings: ${target} is free again`, ok: commandFor(target) == null, detail: `resolves to ${commandFor(target)}` });
      const cleared = await until(persisted, (p) => Object.keys(p).length === 0, 3000);
      checks.push({ name: "bindings: the reset is saved to settings", ok: cleared.ok, detail: JSON.stringify(cleared.value) });
    } finally {
      // The reader's own bindings come back whatever happened above.
      if (Object.keys(original).length) deps.updateBindings(original);
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  /** All three checks, in order (bench `hooks` mode and the e2e). */
  async function selfTest() {
    const orient = await checkOrientation();
    const thumbs = await checkThumbnails();
    const binds = await checkBindings();
    const checks = [...orient.checks, ...thumbs.checks, ...binds.checks];
    return { ok: checks.every((c) => c.ok), checks, orientation: orient.final, thumbnails: thumbs.state };
  }

  return {
    version: 1,
    orientation,
    rotate,
    flip,
    resetOrientation,
    checkOrientation,
    thumbnails: thumbnailState,
    checkThumbnails,
    bindings,
    checkBindings,
    selfTest,
  };
}

export type FlowradTestHook = ReturnType<typeof createTestHook>;

/** Exposes the hook on `window.__flowradTest`; returns the uninstaller. */
export function installTestHook(deps: TestHookDeps): () => void {
  const w = window as unknown as { __flowradTest?: FlowradTestHook };
  w.__flowradTest = createTestHook(deps);
  return () => {
    delete w.__flowradTest;
  };
}
