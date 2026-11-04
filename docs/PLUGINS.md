# Viewer plugins: the extension point

FlowRad Viewer has a **plugin host** (a hook and a loader) and **no plugins**. Plugins are developed
and released from a separate repository. They are **off by default**: with no configuration the viewer
renders exactly as before, with no panel, no plugin fetch and no extra listeners.

| Piece | Where |
| --- | --- |
| Contract + host (framework-free, shared with desktop later) | `packages/viewer-core/src/plugins.ts` |
| Server switch + allowlist + pins | `lib/pluginConfig.ts` |
| Loader (fetch → SHA-256 check → import) | `components/viewer/plugins/loader.ts` |
| Web host wiring (hotkeys, state, lifecycle) | `components/viewer/plugins/usePluginHost.ts` |
| Right-side panel with icon tab rail | `components/viewer/plugins/PluginPanel.tsx` |
| Viewer command bridge | `CornerstoneControls.runCommand` in `components/CornerstoneViewer.tsx` |
| Tests | `lib/plugins.test.ts`, `lib/pluginConfig.test.ts`, `e2e/visual/plugins.spec.ts` (test-fixture plugin only) |

Today the host runs in the **web viewer** (`/viewer`). The contract has no app or React imports
(enforced by `lib/viewerCoreBoundary.test.ts`), so the desktop app can host the same plugins later.

## Turning it on (per deployment)

```bash
VIEWER_PLUGINS_ENABLED=1
VIEWER_PLUGIN_HOSTS=plugins.flowrad.ai
VIEWER_PLUGINS='[{"id":"teaching-tools","url":"https://plugins.flowrad.ai/teaching-tools/1.0.0/index.js","sha256":"<sha256 of that file>"}]'
```

- **Off unless `VIEWER_PLUGINS_ENABLED=1`.** It is read at request time, so it is a Cloud Run setting
  and not baked into the build.
- **URLs** must be same-origin (`/…`) or `https` on a host in `VIEWER_PLUGIN_HOSTS`.
- **Every plugin is pinned by SHA-256.** The browser fetches the file, checks the hash, and imports the
  exact bytes it checked (through a `blob:` URL). If the file changes, it is refused and the plugin's tab
  shows the error. The loader also refuses a file declaring a different id, or one larger than 2 MB.
- **Trust:** plugins run with the viewer's privileges in the reader's browser, including the pixels of
  the study on screen. Only reviewed builds from the plugins repository belong in the list. Sandboxing
  plugins in an iframe is a later option, and the contract is narrow enough to proxy over `postMessage`.

## The contract (API version 1)

A plugin is an ES module whose default export is:

```js
export default {
  id: "teaching-tools",          // 2–40 lower-case letters, digits, dashes
  name: "Teaching tools",
  apiVersion: 1,
  icon: "TT",                    // 1–2 characters, or an https:/data:image URL
  activate(ctx) {                // may be async; may return a cleanup function
    // ...
  },
};
```

`ctx` gives the plugin:

| Area | API | Notes |
| --- | --- | --- |
| Commands | `ctx.commands.openPlane("axial" \| "coronal" \| "sagittal" \| "mpr3d")` | Axial is the acquired stack. Coronal and sagittal open MPR (all three planes together on the web). `mpr3d` opens 3D, falling back to MPR on devices without a WebGL2 volume pipeline. |
| | `scroll(delta)`, `zoom(factor)`, `windowPreset("lung" \| "bone" \| "brain" \| "abdomen")`, `nextSeries(1 \| -1)` | The same code paths as keys, toolbar and voice. A plugin can do nothing the reader couldn't. |
| | `takeKeyImage()` | Returns `{ keyImage: { mimeType, base64, sliceIndex, studyInstanceUID, seriesInstanceUID } }`: the pixels on screen, without overlay text. |
| | `run(command)` | Every command is validated (`parseViewerCommand`). Each result is `{ ok, … }`. Commands never throw. |
| State (read-only) | `ctx.state.get()`, `ctx.state.subscribe(fn)` | `{ study, series, slice, mode }`, deep-frozen. `mode` is what is really on screen: `stack`, `mpr` or `3d`. |
| UI | `ctx.ui.panel` | This plugin's element in the right-side panel. The tab rail shows its icon, and a failed plugin shows its error there. |
| Overlay | `ctx.overlay.create({ interactive? })` | A layer over the viewport. It ignores the pointer unless `interactive`. Removed on unload. |
| Input | `ctx.input.registerHotkey("Alt+Shift+K", fn)` | **Alt+Shift+&lt;key&gt; only**, so a plugin can never take a viewer shortcut. A conflict between plugins is refused. |
| | `ctx.input.registerMicAction({ label, hotkey?, onStart, onStop })` | Adds a mic button to the plugin's panel, plus optional hold-to-talk. The plugin captures audio itself (`getUserMedia`, behind the browser's permission prompt). The core voice commands are unchanged. |

A plugin that throws is isolated. Its tab shows the error, its listeners are dropped, and the viewer
carries on.

## 3D MPR is free core

Multiplanar and 3D viewing (`openPlane("mpr3d")`, the toolbar's MPR and 3D) are planned as **free
core** on web and desktop. `lib/cloud/entitlements.ts` lists them in `FREE_CORE_FEATURES` and refuses
to load if either is ever put in `PAID_FEATURES`. A unit test guards this. Plugins can drive 3D MPR
but can't gate it.

## Not here, by design

No plugins, no plugin marketplace, no remote plugin list, and nothing on by default. The plugin
repository owns its builds and their hashes. This repository only owns the contract, the host and
the switch.
