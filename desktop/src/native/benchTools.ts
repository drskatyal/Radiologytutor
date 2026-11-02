// P2.3 e2e (bench only, FLOWRAD_BENCH_VIEW=native-tools): draw with the real
// tools on the first native viewport through real pointer events, the way a
// reader does, and return what each annotation measured.

import { allAnnotations, measureText, undo, redo } from "./annotations";

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function driveNativeTools(setTool: (t: string) => void) {
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
  // Probe: one click in the middle.
  setTool("Probe");
  await frame();
  await frame();
  fire("pointerdown", at(0.5, 0.5));
  fire("pointerup", at(0.5, 0.5));
  await wait(400);
  const spacing: [number, number] = [1, 1];
  for (const a of allAnnotations()) results[a.tool] = { text: measureText(a, spacing), stats: a.stats ?? null, value: a.value ?? null, points: a.points };
  // Undo removes the last (probe); redo brings it back.
  const before = allAnnotations().length;
  undo();
  const afterUndo = allAnnotations().length;
  redo();
  const drawn = document.querySelectorAll("[data-native-viewport] [data-annotation]").length;
  setTool("StackScroll");
  return { annotations: results, count: before, afterUndo, afterRedo: allAnnotations().length, drawnOnScreen: drawn };
}
