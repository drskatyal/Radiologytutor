# FlowRad Viewer — Phase 2: native renderer (design note)

Status: approved direction (Phase 2 of the Rust rewrite), 2026-11-02. Desktop only;
the web viewer keeps the current Cornerstone/JS path.

## Why

HP bench of 0.7.2 (f4e7300), whole process tree, real GPU:

| | HP today | Target |
|---|---|---|
| Idle with a CT open | 1.02–1.06 GB (WebView2 renderer ~430 MB, GPU process ~400 MB) | < 400 MB |
| Warm first image | CT 573–660 ms, MRI 890–1015 ms | < 300 ms |
| Interaction freezes | 51–109 ms, recurring | ≤ 50 ms |
| Memory after close | +87–228 MB, grows 200–340 MB per round | baseline |
| Whole-run peak (MPR + 3D) | 1.55–1.63 GB | < 1.2 GB |

Most of the 1 GB is not our data. It is the cost of handing pixels to Chromium:
- decoded slices live in the JS heap;
- they are uploaded again as WebGL textures in the GPU process;
- Chromium's compositor keeps its own copies.

Phase 1 already moved the volume, MPR planes, slabs and 3D ray-casting into Rust (MPR peak 2.1 GB → 0.6 GB on CI). But each frame still crosses into the webview as a PNG and is drawn through WebGL. Tuning WebView2 flags moved idle memory by under 5% (CI A/B step). The remaining wins need the pixels to never enter the webview.

## Target architecture

```
┌──────────── Tauri window (one per monitor) ───────────┐
│ WebView2, transparent background  ← on top           │
│   toolbar · series browser · dialogs · menus         │
│   SVG overlay per viewport: annotations, text,       │
│   crosshairs, reference lines · CSS tool cursors     │
│   all input lands here                               │
├───────────────────────────────────────────────────────┤
│ wgpu surface (DX12 / Metal) in the same window ← under│
│   one swapchain, viewports as scissored rects        │
└───────────────────────────────────────────────────────┘
          ▲ view commands (IPC)  │ view state / transforms (events)
          │                      ▼
Rust core (shared by every window):
  file index (mmap) → decoder pool → decoded LRU (byte budget)
  → GPU texture cache (R16, LUT applied in the shader)
  volume store (Phase 1) → MPR / slab / 3D passes on the GPU
```

**What moves to Rust:**
- decoding: dicom-pixeldata plus the codecs below;
- the decoded-slice cache, with a hard byte budget and shared across windows;
- texture upload and 2D display:
  - window/level, zoom, pan, rotate, flip, invert, colour maps;
  - slabs (MIP, MinIP, AvgIP);
  - MPR planes;
  - 3D (volume rendering and MIP);
  - PET/CT fusion blending;
- ROI statistics (HU mean/SD/area, SUV), computed from the source pixels;
- exports (PNG, MP4), produced by reading back from an offscreen target.

**What stays in the web layer:**
- all chrome: toolbar, series browser, layouts, dialogs, right-click menus, the shortcut sheet, voice UI, the monitor picker and drag-and-drop;
- tool state machines and annotation storage;
- annotations drawn as SVG over each viewport, using the transform Rust publishes;
- tool cursors, which keep working because the webview stays on top.

**Interface:** a `NativeViewport` adapter behind the existing viewer seam (`viewerController` / `@flowrad/viewer-core`), so callers do not change. Commands use Tauri IPC:
- `set_cells` (layout rects in device pixels);
- `set_view` (series, slice, W/L, camera);
- `scroll`;
- `pick` (canvas ↔ patient coordinates).

Rust answers with view-state events. Pointer drags are coalesced to one command per animation frame, and the render runs off the UI thread. Goal: input to pixels in under 16 ms.

## Memory budget (idle, CT open, whole tree)

| Part | Budget |
|---|---|
| WebView2 UI only (browser, renderer, GPU compositor, utility) | ≤ 250 MB |
| Rust: decoded LRU 64 MB + index + mmap'd pages actually touched | ≤ 120 MB |
| Native GPU textures (shared/dedicated VRAM; not working set on a discrete GPU) | — |
| **Total** | **< 400 MB** |

The first step measures the WebView2 floor on the HP: the start screen, whole tree, with no Cornerstone loaded. If the floor alone is over ~280 MB, the 400 MB gate cannot be met with any WebView2 UI. We would then report that number and decide between a native UI and adjusting the gate.

## Phases — one draft PR each into `claude/epic-noether-3nvcbf`

Each phase sits behind a `nativeViewer` setting plus the `FLOWRAD_NATIVE=1` env var until P2.6. Each ships an x64 installer artifact for an HP re-bench. Each keeps all existing e2e green, on the JS path and on the native path (windows-e2e).

**P2.0 — Spike and floor.**
- wgpu surface under a transparent WebView2 in a Tauri 2 window (Windows DX12; macOS Metal).
- Checks: resize, DPI changes, multi-monitor moves, WARP on CI.
- Measure the WebView2 UI floor (whole tree) on CI and the HP.
- Fallback if transparency compositing fails: native child surfaces placed at the cell rects, with menus that overlap a viewport switched to native popups.
- Go/no-go recorded in `DECISIONS.md`.

**P2.1 — Native first paint and image core.**
- Rust paints the start screen or splash before WebView2 finishes navigating (target: cold first paint < 500 ms).
- Decoder pool and decoded LRU, with a byte budget and prefetch around the current slice and the next series.
- Codecs:
  - JPEG baseline/lossless;
  - JPEG 2000 and HTJ2K (openjpeg 2.5);
  - JPEG-LS (charls);
  - RLE and deflate.
- Fixture matrix parity, with any unsupported syntax falling back to the JS path.

**P2.2 — 2D stack on wgpu.**
- One swapchain with N cells and an R16 texture per slice.
- W/L as a shader LUT.
- Supports zoom, pan, rotate, flip, invert, colour maps, scroll, cine and linked scroll.
- The text overlay is drawn in the web layer from the view-state events.
- Gates: warm first image < 300 ms; frame p95 ≤ 16.7 ms; idle with a CT open < 400 MB.

**P2.3 — Tools and annotations.**
- Length, angle, Cobb, arrow and label, ellipse/rectangle/freehand ROI with HU and SUV, probe, eraser, undo/redo.
- Spine labelling; key images; drawn in SVG from the shared transform.
- Right-click menus and cursors work unchanged; voice commands go to the same view commands.
- E2e parity with the current tool suite.

**P2.4 — Slabs and MPR on the GPU.**
- The Phase 1 volume uploaded as a 3D texture (or bricked under the budget).
- MPR, oblique, crosshairs, reference lines, slab MIP/MinIP/AvgIP, curved MPR.
- Multi-monitor windows share one volume.
- Gates: MPR build < 2 s; peak < 1.2 GB; back to baseline on close.

**P2.5 — 3D and fusion on the GPU.**
- Port `render3d.rs` ray-casting to a wgpu compute/fragment pass: VR presets, MIP, cut plane, 3D cursor.
- PET/CT and MR/CT fusion with the blend slider.
- Export via offscreen readback.

**P2.6 — Cutover.**
- The native renderer becomes the default on Windows and macOS.
- The JS path remains as the fallback: no adapter, lost device, Linux, or a codec it can't decode.
- Cornerstone is dropped from the desktop startup bundle, which helps cold start.
- CI gates move to whole-tree working set on the native path.

## Measuring

- The bench and CI gate on **whole-tree working set**, which is what Task Manager shows. Private bytes are reported alongside but no longer gate.
- Per-phase peaks are reported (open, 2D, MPR, 3D, close) for the full sequence and for each `-View` option. The leak report names the process that retained memory.
- The HP remains the release gate. CI (WARP) gates regressions.

## Risks

1. **Transparent WebView2 over a DX12 swapchain.**
   - Supported by wry's transparent mode, but untested with a swapchain underneath; P2.0 proves it.
   - Fallback: native cells on top of the webview.
2. **IPC latency for drags.**
   - Coalesce to one command per frame; measure input→pixels in `interact`.
   - Fallback: forward native pointer events straight to Rust.
3. **Codec coverage.** Unsupported transfer syntaxes fall back to JS per series, so there is no blank viewport.
4. **Linux and WebKitGTK.** The shell-and-smoke job stays on the JS path; the native path is gated on windows-e2e and perf-windows.
5. **Scope.** The tool and annotation parity in P2.3 is the largest step. Each tool keeps its current e2e as the acceptance test.
