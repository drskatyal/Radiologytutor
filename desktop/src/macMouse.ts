// macOS: side mouse buttons and tilt wheels for bindings.
//
// WKWebView reports every extra button as the middle one and scrolls a tilt
// wheel like a trackpad, so the shell's AppKit monitor (src-tauri/src/
// mac_mouse.rs) reads them and sends `native-mouse`. Here they are
// re-dispatched at the cursor as ordinary pointer / mouse / wheel events, so
// the bindings listener, the viewports and the "press the button you want to
// bind" pad handle them exactly as they do on Windows.
//
// The monitor only acts while the page wants it: a binding uses a side
// button or tilt, or the Mouse & Keyboard panel is open (capture).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeMouseWanted } from "@flowrad/viewer-core/bindings";

export interface NativeMouse {
  kind: "down" | "up" | "tilt";
  /** DOM button index: back 3, forward 4, then 5, 6… */
  button: number;
  /** Tilt: -1 left, 1 right. */
  dir: number;
  x: number;
  y: number;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/** Fire `e` at the element under the cursor, as the webview would have. */
export function redispatch(e: NativeMouse, doc: Document = document): void {
  const target = doc.elementFromPoint(e.x, e.y) ?? doc.body;
  const view = doc.defaultView ?? undefined;
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX: e.x,
    clientY: e.y,
    ctrlKey: e.ctrl,
    metaKey: e.meta,
    altKey: e.alt,
    shiftKey: e.shift,
  };
  if (e.kind === "tilt") {
    // Line mode: a notch, which tilt detection tells apart from a trackpad swipe.
    target.dispatchEvent(new WheelEvent("wheel", { ...base, deltaX: e.dir * 3, deltaY: 0, deltaMode: 1 }));
    return;
  }
  const down = e.kind === "down";
  const buttons = down ? 2 ** e.button : 0;
  const mouse = { ...base, button: e.button, buttons };
  target.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup", { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  target.dispatchEvent(new MouseEvent(down ? "mousedown" : "mouseup", mouse));
  if (!down) target.dispatchEvent(new MouseEvent("auxclick", mouse));
}

let specs: string[] = [];
let capturing = false;
let sent = "";

function send(): void {
  const want = nativeMouseWanted(specs);
  const buttons = want.buttons || capturing;
  const tilt = want.tilt || capturing;
  const key = `${buttons}${tilt}`;
  if (key === sent) return;
  sent = key;
  void invoke("native_mouse_wanted", { buttons, tilt }).catch(() => {
    sent = "";
  });
}

/** The inputs bound now (every effective spec); asks the shell for what they need. */
export function setNativeMouseBindings(next: Iterable<string>): void {
  specs = [...next];
  send();
}

/** The Mouse & Keyboard panel is open: forward every side button and tilt. */
export function setNativeMouseCapturing(open: boolean): void {
  capturing = open;
  send();
}

/** Start re-dispatching the shell's events (once, macOS only). */
export function startNativeMouse(): () => void {
  let stop: (() => void) | null = null;
  let gone = false;
  void listen<NativeMouse>("native-mouse", (ev) => redispatch(ev.payload)).then((un) => {
    if (gone) un();
    else stop = un;
  });
  return () => {
    gone = true;
    stop?.();
  };
}
