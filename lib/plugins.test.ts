import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_API_VERSION,
  createPluginHost,
  hotkeyOf,
  parsePluginHotkey,
  parseViewerCommand,
  validatePlugin,
  type FlowradViewerPlugin,
  type PluginContext,
  type ViewerCommand,
} from "../packages/viewer-core/src/plugins.ts";

async function makeHost() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><div id=overlay></div>");
  const doc = dom.window.document;
  const ran: ViewerCommand[] = [];
  const host = createPluginHost({
    run: async (c) => {
      ran.push(c);
      return c.type === "takeKeyImage" ? { ok: true, keyImage: { mimeType: "image/jpeg", base64: "AA==" } } : { ok: true };
    },
    overlayRoot: () => doc.getElementById("overlay") as unknown as HTMLElement,
    createElement: (tag) => doc.createElement(tag) as unknown as HTMLElement,
  });
  return { host, ran, doc };
}

const plugin = (over: Partial<FlowradViewerPlugin> = {}): FlowradViewerPlugin => ({
  id: "demo-plugin",
  name: "Demo",
  apiVersion: PLUGIN_API_VERSION,
  activate: () => undefined,
  ...over,
});

test("commands are validated before they reach the viewer", () => {
  assert.deepEqual(parseViewerCommand({ type: "openPlane", plane: "mpr3d" }), { type: "openPlane", plane: "mpr3d" });
  assert.deepEqual(parseViewerCommand({ type: "windowPreset", preset: "bone" }), { type: "windowPreset", preset: "bone" });
  assert.deepEqual(parseViewerCommand({ type: "nextSeries" }), { type: "nextSeries", delta: 1 });
  assert.equal(typeof parseViewerCommand({ type: "openPlane", plane: "oblique" }), "string");
  assert.equal(typeof parseViewerCommand({ type: "scroll", delta: 0.5 }), "string");
  assert.equal(typeof parseViewerCommand({ type: "zoom", factor: 100 }), "string");
  assert.equal(typeof parseViewerCommand({ type: "deleteStudy" }), "string");
});

test("plugin hotkeys are Alt+Shift only, so core shortcuts can never be taken", () => {
  assert.deepEqual(parsePluginHotkey("Alt+Shift+K"), { key: "k" });
  assert.deepEqual(parsePluginHotkey("shift+alt+f2"), { key: "f2" });
  for (const bad of ["K", "Shift+K", "Ctrl+Alt+Shift+K", "Alt+K", "Alt+Shift+Enter"]) {
    assert.equal(typeof parsePluginHotkey(bad), "string", bad);
  }
  assert.equal(hotkeyOf({ key: "Ǩ", code: "KeyK", altKey: true, shiftKey: true }), "k", "layout-proof via code");
  assert.equal(hotkeyOf({ key: "K", code: "KeyK", shiftKey: true }), null);
});

test("manifest validation", () => {
  assert.equal(typeof validatePlugin(plugin()), "object");
  assert.match(String(validatePlugin(plugin({ apiVersion: 2 }))), /API version/);
  assert.match(String(validatePlugin(plugin({ id: "Bad Id" }))), /id/);
  assert.match(String(validatePlugin(plugin({ icon: "<svg onload=alert(1)>" }))), /icon/);
  assert.match(String(validatePlugin({})), /id/);
});

test("a plugin drives the viewer, reads frozen state, gets a panel and an overlay", async () => {
  const { host, ran, doc } = await makeHost();
  let ctx!: PluginContext;
  const seen: number[] = [];
  await host.register(plugin({ activate: (c) => void (ctx = c) }));
  ctx.state.subscribe((s) => seen.push(s.slice?.index ?? -1));
  host.setState({ study: { seriesCount: 2 }, series: { index: 0, imageCount: 40 }, slice: { index: 7, count: 40 }, mode: "stack" });
  assert.deepEqual(seen, [7]);
  assert.throws(() => {
    (ctx.state.get().slice as { index: number }).index = 99;
  }, "state is read-only");
  await ctx.commands.openPlane("coronal");
  await ctx.commands.scroll(-3);
  const key = await ctx.commands.takeKeyImage();
  assert.equal(key.ok && key.keyImage?.mimeType, "image/jpeg");
  const bad = await ctx.commands.run({ type: "openPlane", plane: "oblique" } as unknown as ViewerCommand);
  assert.equal(bad.ok, false);
  assert.deepEqual(ran.map((c) => c.type), ["openPlane", "scroll", "takeKeyImage"]);
  ctx.ui.panel.textContent = "hello";
  const layer = ctx.overlay.create();
  assert.equal(layer.style.pointerEvents, "none");
  assert.equal(doc.getElementById("overlay")!.children.length, 1);
  host.dispose();
  assert.equal(doc.getElementById("overlay")!.children.length, 0, "overlays removed on dispose");
});

test("hotkeys and hold-to-talk mic actions route to their plugin; conflicts are refused", async () => {
  const { host } = await makeHost();
  let a!: PluginContext;
  let b!: PluginContext;
  await host.register(plugin({ id: "plugin-a", activate: (c) => void (a = c) }));
  await host.register(plugin({ id: "plugin-b", activate: (c) => void (b = c) }));
  let pressed = 0;
  const mic: string[] = [];
  a.input.registerHotkey("Alt+Shift+K", () => pressed++);
  assert.throws(() => b.input.registerHotkey("Alt+Shift+K", () => undefined), /already used/);
  b.input.registerMicAction({ label: "Dictate", hotkey: "Alt+Shift+M", onStart: () => mic.push("start"), onStop: () => mic.push("stop") });
  assert.equal(host.handleKeyDown({ key: "K", code: "KeyK", altKey: true, shiftKey: true }), true);
  assert.equal(host.handleKeyDown({ key: "K", code: "KeyK" }), false, "plain K stays the viewer's");
  host.handleKeyDown({ key: "M", code: "KeyM", altKey: true, shiftKey: true });
  host.handleKeyDown({ key: "M", code: "KeyM", altKey: true, shiftKey: true, repeat: true });
  host.handleKeyUp({ key: "m", code: "KeyM" });
  assert.equal(pressed, 1);
  assert.deepEqual(mic, ["start", "stop"]);
  assert.equal(host.entries().find((e) => e.id === "plugin-b")!.micActions.length, 1);
});

test("a plugin that throws is isolated: error status, viewer unaffected", async () => {
  const { host } = await makeHost();
  const entry = await host.register(plugin({ activate: () => { throw new Error("boom"); } }));
  assert.equal(entry.status, "error");
  assert.equal(entry.error, "boom");
  await assert.rejects(host.register(plugin()), /already loaded/);
  let ctx!: PluginContext;
  await host.register(plugin({ id: "listener", activate: (c) => void (ctx = c) }));
  ctx.state.subscribe(() => { throw new Error("listener bug"); });
  assert.doesNotThrow(() => host.setState({ study: null, series: null, slice: null, mode: "mpr" }));
});
