// TEST FIXTURE ONLY — not a FlowRad plugin and never shipped or served by the
// app. e2e/visual/plugins.spec.ts serves it through a Playwright route to
// exercise the plugin host contract (packages/viewer-core/src/plugins.ts).

export default {
  id: "e2e-demo",
  name: "E2E demo",
  apiVersion: 1,
  icon: "E2",
  activate(ctx) {
    const p = ctx.ui.panel;
    const out = document.createElement("pre");
    out.dataset.testid = "e2e-state";
    p.appendChild(out);
    const show = (s) => {
      out.textContent = JSON.stringify({ series: s.series && s.series.index, slice: s.slice && s.slice.index, mode: s.mode });
    };
    show(ctx.state.get());
    ctx.state.subscribe(show);
    const button = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = async () => {
        const r = await fn();
        b.dataset.result = r.ok ? (r.keyImage ? `key:${r.keyImage.mimeType}:${r.keyImage.sliceIndex}` : "ok") : `fail:${r.reason}`;
      };
      p.appendChild(b);
    };
    button("scroll +5", () => ctx.commands.scroll(5));
    button("bone", () => ctx.commands.windowPreset("bone"));
    button("zoom", () => ctx.commands.zoom(1.5));
    button("key image", () => ctx.commands.takeKeyImage());
    button("3D MPR", () => ctx.commands.openPlane("mpr3d"));
    button("axial", () => ctx.commands.openPlane("axial"));
    let overlay = null;
    button("overlay", async () => {
      overlay = overlay || ctx.overlay.create();
      overlay.innerHTML = '<div data-testid="e2e-overlay" style="position:absolute;left:10px;top:10px;color:yellow">overlay</div>';
      return { ok: true };
    });
    let hits = 0;
    ctx.input.registerHotkey("Alt+Shift+K", () => {
      hits += 1;
      out.dataset.hotkeys = String(hits);
    });
    ctx.input.registerMicAction({
      label: "Dictate",
      hotkey: "Alt+Shift+M",
      onStart: () => (out.dataset.mic = "on"),
      onStop: () => (out.dataset.mic = "off"),
    });
  },
};
