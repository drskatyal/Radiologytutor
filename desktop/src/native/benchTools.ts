// P2.3 e2e (bench only, FLOWRAD_BENCH_VIEW=native-tools): draw with the real
// tools on the first native viewport through real pointer events, the way a
// reader does, and return what each annotation measured.

import { allAnnotations, measureText, undo, redo } from "./annotations";

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function driveNativeTools(setTool: (t: string) => void) {
  // Draw only once the viewport's image <-> cell mapping is valid (it follows
  // the first layout by a frame or two), as a reader's first click would.
  for (let i = 0; i < 100 && !document.querySelector('[data-native-viewport][data-native-ready="1"]'); i += 1) await wait(50);
  const svg = document.querySelector("[data-native-viewport] [data-native-annotations]") as SVGSVGElement | null;
  if (!svg) return { error: "no native viewport with an annotation layer" };
  const r = svg.getBoundingClientRect();
  const at = (fx: number, fy: number) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
  const fire = (type: string, p: { clientX: number; clientY: number }) =>
    svg.dispatchEvent(new PointerEvent(type, { ...p, bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, isPrimary: true }));
  const dragLine = async (a: [number, number], b: [number, number]) => {
    fire("pointerdown", at(...a));
    await frame();
    for (let i = 1; i <= 8; i += 1) {
      fire("pointermove", at(a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8));
      await frame();
    }
    fire("pointerup", at(...b));
    await wait(300);
  };
  const results: Record<string, unknown> = {};
  for (const [tool, a, b] of [
    ["Length", [0.3, 0.5], [0.7, 0.5]],
    ["EllipticalROI", [0.4, 0.4], [0.6, 0.6]],
    ["RectangleROI", [0.42, 0.42], [0.58, 0.58]],
  ] as const) {
    setTool(tool);
    await frame();
    await frame();
    await dragLine(a as [number, number], b as [number, number]);
  }
  // Probe: one click on free anatomy (a click ON an annotation selects it).
  setTool("Probe");
  await frame();
  await frame();
  fire("pointerdown", at(0.5, 0.3));
  fire("pointerup", at(0.5, 0.3));
  await wait(400);
  const spacing: [number, number] = [1, 1];
  for (const a of allAnnotations()) results[a.tool] = { text: measureText(a, spacing), stats: a.stats ?? null, value: a.value ?? null, points: a.points };
  // Undo removes the last (probe); redo brings it back.
  const before = allAnnotations().length;
  undo();
  const afterUndo = allAnnotations().length;
  redo();
  const afterRedo = allAnnotations().length;
  const drawn = document.querySelectorAll("[data-native-viewport] [data-annotation]").length;

  // HP 0.8.0: keys, menus and cursors in native mode, with every error counted.
  const keys = await driveKeys(setTool);
  setTool("StackScroll");
  // Real OS input (the e2e moves the mouse and types): see watchOsInput.
  void watchOsInput(setTool);
  return { annotations: results, count: before, afterUndo, afterRedo, drawnOnScreen: drawn, ...keys };
}

/** Errors thrown or logged while `run` runs (window errors, rejections, console.error). */
async function collectErrors<T>(run: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const onError = (e: ErrorEvent) => errors.push(String(e.message));
  const onRejection = (e: PromiseRejectionEvent) => errors.push(String((e.reason as Error)?.message ?? e.reason));
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 300));
    original(...args);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  try {
    const result = await run();
    await wait(300);
    return { result, errors };
  } finally {
    console.error = original;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  }
}

const press = async (key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  const code = key.length === 1 ? (/[0-9]/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true, ...mods }));
  await frame();
  await frame();
};

async function driveKeys(setTool: (t: string) => void) {
  const { result, errors } = await collectErrors(async () => {
    // Esc in every state the reader meets: idle, with a tool, twice in a row.
    for (const k of ["Escape", "w", "Escape", "Escape", "p", "Escape", "z", "Escape"]) await press(k);
    // Navigation, display, sync / reference lines, overlay, reset (each once and back).
    for (const k of ["ArrowDown", "ArrowUp", "i", "i", "q", "h", "v", "1", "0", "Backspace", "F12", "F12", "F5", "F5"]) await press(k);
    for (const m of [{ shiftKey: true }, { shiftKey: true }, { altKey: true }, { altKey: true }]) await press("F5", m);
    // Ctrl+Z / Ctrl+Y go through the app's shortcut map to the native store: one step each.
    const n0 = allAnnotations().length;
    await press("z", { ctrlKey: true });
    const n1 = allAnnotations().length;
    await press("y", { ctrlKey: true });
    const n2 = allAnnotations().length;
    // Tool cursors on the native viewport (each tool its own, as on the JS path).
    const vp = document.querySelector("[data-native-viewport]") as HTMLElement | null;
    const cursors: Record<string, string> = {};
    for (const t of ["StackScroll", "WindowLevel", "Zoom", "Pan", "Length", "Eraser"]) {
      setTool(t);
      await frame();
      await frame();
      cursors[t] = vp ? getComputedStyle(vp).cursor.slice(0, 40) : "";
    }
    setTool("StackScroll");
    // The series thumbnail's right-click menu (was empty in native mode).
    const card = document.querySelector('nav[aria-label="Series"] li button') as HTMLElement | null;
    let thumbMenuItems = -1;
    if (card) {
      const r = card.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 10, clientY: r.top + 10 }));
      await wait(400);
      // Items that are actually laid out (an empty-looking menu had them at 0 px).
      thumbMenuItems = [...document.querySelectorAll('[data-testid="viewer-context-menu"] [role^="menuitem"]')].filter(
        (el) => el.getBoundingClientRect().height > 8 && el.getBoundingClientRect().bottom <= window.innerHeight + 1
      ).length;
      await press("Escape");
    }
    return { keyUndo: { before: n0, afterUndo: n1, afterRedo: n2 }, cursors, thumbMenuItems };
  });
  return { ...result, keyErrors: errors };
}

/**
 * Real OS input for the e2e (e2e-native.py --tools): select Length, report the
 * annotation layer's physical screen rect, then report every change in the
 * annotation count while the script drags with the real mouse and presses
 * Ctrl+Z with the real keyboard. Stops after 90 s.
 */
async function watchOsInput(setTool: (t: string) => void) {
  await wait(1500);
  const { invoke, benchReport } = await import("../platform");
  setTool("Length");
  const svg = document.querySelector("[data-native-viewport] [data-native-annotations]") as SVGSVGElement | null;
  const r = svg?.getBoundingClientRect();
  const st = await invoke<{ clientOrigin?: [number, number] | null; scale?: number | null }>("native_status").catch(() => null);
  const scale = st?.scale ?? window.devicePixelRatio;
  const [ox, oy] = st?.clientOrigin ?? [0, 0];
  const errors: string[] = [];
  const onError = (e: ErrorEvent) => errors.push(String(e.message));
  window.addEventListener("error", onError);
  await benchReport({
    view: "native-tools-os",
    phase: "ready",
    count: allAnnotations().length,
    cellScreen: r && { x: Math.round(ox + r.left * scale), y: Math.round(oy + r.top * scale), w: Math.round(r.width * scale), h: Math.round(r.height * scale) },
  });
  let last = allAnnotations().length;
  const end = performance.now() + 90_000;
  while (performance.now() < end) {
    await wait(150);
    const n = allAnnotations().length;
    if (n === last) continue;
    last = n;
    const lengths = allAnnotations().filter((a) => a.tool === "Length").length;
    await benchReport({
      view: "native-tools-os",
      phase: "count",
      count: n,
      lengths,
      drawn: document.querySelectorAll("[data-native-viewport] [data-annotation]").length,
      errors,
    });
  }
  window.removeEventListener("error", onError);
}
