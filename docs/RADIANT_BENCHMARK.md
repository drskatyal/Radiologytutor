# RadLearn Viewer vs RadiAnt DICOM Viewer

Date: 2026-10-31. Branch `claude/desktop-viewer`. Updated at each milestone.

RadiAnt is the bar the brief set: a fast, small, polished Windows viewer that
radiologists already install on purpose. This document compares RadLearn Viewer
(`desktop/`) against it on **speed**, **features** and **UX**. Every claim is
marked by where it came from. Gaps are listed in the order we close them.

---

## 1. Speed and footprint

### 1.1 RadiAnt, measured

Measured by Sanyam on his own laptop: HP, Intel Core Ultra 7, 16 GB RAM,
Windows 11, RadiAnt **2026.1**.

| metric | RadiAnt 2026.1 |
|---|---|
| Installed size | **9.8 MB** |
| Cold start → window | **397 ms** |
| Warm relaunch | **95 ms** |
| Idle RAM | **~30 MB** |
| Study open | not timed (the trial had expired) |

**Hard targets** for RadLearn Viewer, set from those numbers:

- cold start under **0.5 s**;
- low idle RAM;
- a small installer, about the size of RadiAnt's.

### 1.2 RadLearn Viewer, measured

**Machine.** Every number in this section comes from the Linux container this
branch was built in, not the HP:

- 4 vCPU, 15 GB RAM;
- Ubuntu 24.04;
- WebKitGTK 2.4x on Xvfb;
- **CPU-only OpenGL** (Mesa llvmpipe).

That is close to a worst case for a WebView app. Both startup and GPU work are
slower than on a laptop with a real GPU and WebView2. The table is honest about
this setup. It is not a like-for-like comparison with §1.1.

**How to measure on the HP.** To compare on the same laptop, run
`desktop/scripts/bench.mjs` there (§1.5). That is the next measurement owed.

**Release build.** `npx tauri build --no-bundle`, LTO, `opt-level=3`.

| metric | RadLearn Viewer (this box) | how |
|---|---|---|
| App binary (renderer, every codec and WASM embedded) | **11.0 MB** uncompressed | `ls -l target/release/radlearn-viewer` |
| Cold start → painted start screen | **0.81 s** median of 6 (0.80 s first run) | `bench.mjs coldstart` |
| … of which WebKitGTK startup, before our JS runs | ~0.70 s | `jsStartMs` mark |
| … of which our JS, start → paint | ~0.11 s | `firstPaintMs − jsStartMs` |
| Idle memory, whole process tree (PSS) | **224 MB** (418 MB before the fix in §1.4) | `/proc/*/smaps_rollup` |
| Memory with a 360-image CT open | 478 MB PSS | same |

### 1.3 Opening a study: before vs after

**Before** is the web viewer's local loader, `lib/localDicomFiles.ts`, which
backs `/viewer/local` today. It runs in headless Chromium on the same box,
driven by `bench.mjs browser`.

**After** is the desktop app (release build), driven by `bench.mjs desktop`.

**Cold vs warm.** "Cold" means an empty scan cache. "Warm" means a re-open
that hits the on-disk scan cache. The OS page cache was warm in both cases, so
these figures are not first-read-from-disc times.

| study | metric | before (web loader) | after (desktop) |
|---|---|---|---|
| CT phantom: 360 files, 2 series, 512² | all headers parsed | **15.3 s** | **34 ms** cold · 14 ms warm |
| | first image on screen | **25–51 s** | **0.72 s** cold · 0.78 s warm |
| | whole study ready | 15.3 s + render | **0.52 s** |
| CTA-sized: 1,200 files, 600 MB | all headers parsed | **13.4 s** | **79 ms** cold · 29 ms warm |
| | first image on screen | **52.5 s** (1 run) | **0.74 s** cold · 0.78 s warm |
| CD layout with DICOMDIR: 84 images, 2 studies | headers, via the index | — | 10 ms |
| | first image | — | 0.78 s |

**What dominates the first image now: engine startup, not files.**

- Cornerstone init takes ~350 ms on llvmpipe (WebGL context, tool registration,
  codec workers).
- The headers are parsed long before the first image renders: Rust finishes a
  360-file folder in 34 ms.
- On this box the first image takes ~0.75 s no matter how big the study is,
  which is the signature of a fixed startup cost.

**Progressive open matters on slow media.** The first series is shown while
the rest of the disc is still being read. Here, local files come off the page
cache so fast that scanning finishes first. On a real CD or a network share
the order flips, and the reader sees images seconds earlier.

**Why "before" is so slow.**

- The web loader reads and parses headers one at a time, on the main thread,
  through the File API. That is ~42 ms per file in Chromium.
- It shows nothing until every header is parsed.

The desktop scanner fixes all three problems:

- it parses on every core (rayon), with `dicom-rs`;
- it stops reading at PixelData;
- it streams headers to the renderer as they are parsed.

**Caveat on the "before" first-image column.** Headless Chromium renders
WebGL through SwiftShader, so it is slower than the WebKitGTK/llvmpipe path the
desktop app uses here. The header-parse column is the clean like-for-like
number: same files, same box, and it does not depend on GPU work.

### 1.4 What closed part of the footprint gap in this milestone

- **The engine loads on intent, not at idle.** Before, Cornerstone (~3 MB of
  JS, WebGL and workers) was pre-warmed while the start screen sat idle. Now it
  loads when the user shows intent:
  - an open dialog opens;
  - something is dragged over the window;
  - the pointer hovers a recent study or a disc;
  - a path is passed on launch.

  Even in the worst case that is hundreds of milliseconds before the first
  pixel is needed, and an idle viewer stays small.
- **WebKitGTK's DMA-BUF renderer is off by default on Linux.** This took
  idle PSS from 418 to 224 MB and cut first paint by ~130 ms. WebGL is
  unaffected, which was verified with all 18 fixture sources. An explicit
  `WEBKIT_DISABLE_DMABUF_RENDERER` set by the user still wins.

### 1.5 Measure it on the HP (owed)

```powershell
npm ci; npm ci --prefix desktop
npm --prefix desktop run tauri build -- --no-bundle
node desktop/scripts/bench.mjs coldstart desktop\src-tauri\target\release\radlearn-viewer.exe --runs 6
python desktop\scripts\make-fixtures.py --bench C:\fixtures
node desktop/scripts/bench.mjs desktop desktop\src-tauri\target\release\radlearn-viewer.exe C:\fixtures\bench\ct-1200
```

Read idle RAM from Task Manager. On Windows the WebView2 processes appear under
the app's group; add them all up.

**What to expect, from the architecture.** These are not measurements yet:

- **Startup.** WebView2 is Chromium, and a warm WebView2 runtime starts in a
  few hundred ms. We expect the cold start to land near the 0.5 s target but
  not reliably under it, and the warm relaunch to be well under RadiAnt's
  first-run time but above its 95 ms.
- **Idle RAM.** We will not reach ~30 MB. Any WebView-based app pays roughly
  80–150 MB for the browser engine's processes. Matching RadiAnt here would
  mean a native renderer. That is a different product decision, recorded in
  §4.

---

## 2. Features

**Sources and legend.**

- RadiAnt facts come from radiantviewer.com pages (features, manual,
  shortcuts, version history), read via search snippets because the site
  blocked direct fetches from this environment. Unverified items are marked
  "?".
- ✅ shipped in this branch · 🟡 partial · ⏳ planned milestone · ✖ not
  planned.

| capability | RadiAnt 2026.1 | RadLearn Viewer |
|---|---|---|
| **Platforms** | Windows only. macOS only through CrossOver | ✅ Windows, ✅ **macOS (native, universal)**, ✅ Linux |
| **Price / licence** | paid licence, time-limited trial | ✅ free, no trial wall |
| **Installer** | setup.exe (~7 MB), 9.8 MB installed | ⏳ M3: .msi + .exe (NSIS), .dmg, .AppImage/.deb from CI |
| **Auto-update** | ? | ⏳ M3: Tauri updater, signed, user-controlled |
| **Open: folder / files / drag-drop** | ✅ | ✅ including OS drag-drop, "Open with…" and command-line paths |
| **Open: DICOMDIR** | ✅ also builds thumbnails from it | ✅ index-driven, case-insensitive, ISO 9660 `;1` tolerant, falls back to a walk when the index is stale |
| **Open: zip** | ✅ including encrypted (prompts for password) | ✅ unencrypted. Encrypted archives get a clear message. Extracted once into the cache, zip-slip safe |
| **Open: CD/DVD** | ✅ Ctrl+Alt+O | ✅ Ctrl+Alt+O. Drives auto-detected on all three OSes, and DICOMDIR flagged |
| **PACS: C-FIND / C-MOVE / C-GET / C-STORE** | ✅ | ⏳ M3: DICOMweb (QIDO/WADO) first, DIMSE via `dicom-ul` after |
| **Progressive display while loading** | ✅ "images can be browsed while still being opened" | ✅ the scanner streams headers and the first series hangs at once |
| **Transfer syntaxes** | JPEG baseline/lossless, JPEG-LS, J2K, RLE, deflate; HTJ2K? | ✅ **all of these, HTJ2K included**: 10/10 syntax fixtures plus multiframe verified in the real app |
| **Multiframe / cine** | ✅ | ✅ frame rate read from FrameTime / RecommendedDisplayFrameRate |
| **DICOM video (MPEG-2/H.264)** | ✅ | ✖ not yet |
| **Series browser with thumbnails** | ✅ | ✅ decoded thumbnails at low priority, drag onto any viewport |
| **Study history / local database** | ✅ database, keywords, CSV | 🟡 recent studies (paths and descriptions, no PHI) plus scan cache. A searchable archive is ⏳ M3 |
| **Layouts** | multiple series and windows | ✅ 1×1 to 3×3, maximise a cell (Enter or double-click), hang by drag-and-drop |
| **Side-by-side compare** | ✅ | ✅ any series in any cell, across studies |
| **Synchronised scrolling** | ✅ automatic within a plane | ✅ F5, position-based, works across series and studies sharing a frame of reference |
| **Reference lines** | ✅ | ✅ Ctrl+F12 |
| **3D cursor** | ✅ | ⏳ M2, through MPR crosshairs |
| **W/L, presets, custom WW/WL** | ✅ Ctrl+F11 | ✅ right-drag, 1–9 modality presets, Ctrl+F11 dialog, invert |
| **Zoom / pan / rotate / flip** | ✅ | ✅ including RadiAnt's Ctrl+0–4 zoom levels and Ctrl+arrow pan |
| **Length, angle, Cobb** | ✅ | ✅ |
| **Ellipse ROI with stats** | ✅ mean/min/max/area/SD | ✅ same stats, in HU |
| **Rectangle / circle / freehand ROI** | polygon ✅, rectangle ? | ✅ rectangle, circle, freehand |
| **Probe, arrow, bidirectional, magnifier** | arrow ✅, pen ✅ | ✅ all four |
| **MPR (orthogonal / oblique)** | ✅ | ⏳ M2 |
| **MIP / MinIP / average slab** | ✅ | ⏳ M2 |
| **3D volume rendering** | ✅ | ⏳ M2 |
| **PET-CT fusion with SUV** | ✅ | ⏳ M2 |
| **Time-intensity curves** | ✅ | ✖ not planned |
| **Export JPEG / PNG** | JPEG, BMP | ⏳ M2: JPEG, PNG |
| **Export video** | WMV, MP4 | ⏳ M2: MP4 (WebCodecs) or WebM |
| **Export DICOM, anonymised** | ✅ (anonymisation is a paid add-on) | ⏳ M2: free, PS3.15 basic profile scrub, consistent UID remap. The Rust side is already built |
| **Printing** | ✅ (2025.1) | ✖ not planned |
| **Keyboard shortcuts** | ✅ | ✅ RadiAnt's documented keys plus a full sheet (F1) |
| **Teaching overlays / RadLearn hand-off** | ✖ | ⏳ M3: sign in and send a study, anonymised on this machine first |

### 2.1 Where RadLearn Viewer already beats RadiAnt

- **A native Mac build.** RadiAnt has none, and its vendor says it has no
  plans for one.
- **No trial wall,** and free anonymisation.
- **HTJ2K decoding,** verified bit-exact against the source. RadiAnt's HTJ2K
  support is unverified.
- **Privacy by construction.**
  - The `dicom://` protocol only serves files the user opened.
  - There is no filesystem plugin.
  - History and caches hold no patient identifiers.
- **Ties into RadLearn's teaching product** (M3).

---

## 3. UX notes

| | RadiAnt | RadLearn Viewer |
|---|---|---|
| Look | classic Win32 chrome, dense, dark viewport | dark reading-room chrome, one cobalt accent, Inter, tabular numerics (same tokens as the web app) |
| First run | empty viewer and menu bar | a start screen with Folder / Files / Zip / DICOMDIR, detected discs, and recent studies |
| Tool switching | single-letter keys | the same letters; every tooltip shows its key |
| Mouse | left = tool, middle = W/L, back button = pan | left = tool, right = W/L, middle = pan, wheel = slice, Ctrl+wheel = zoom |
| Overlay | patient, study and image corners | the same, with orientation letters, and a compact variant for small cells |
| Distraction-free mode | Shift+Alt+Enter | Shift+Alt+Enter; Tab hides the series browser |

---

## 4. Gaps, in the order we close them

1. **M2:**
   - MPR with linked crosshairs, MIP/MinIP slab, 3D volume rendering, and
     PET/CT fusion with SUV;
   - export to PNG/JPEG/MP4 and anonymised DICOM;
   - a 3D cursor through the crosshairs.

   These are the user-named gaps.
2. **M3:**
   - installers and signed auto-update from CI;
   - a searchable local archive;
   - DICOMweb query/retrieve, with DIMSE C-FIND/C-MOVE after;
   - RadLearn sign-in and send.
3. **Re-measure on the HP** (§1.5). If cold start is still over 0.5 s there,
   the remaining levers are:
   - cut the startup bundle further: framer-motion and Radix load lazily
     behind the first dialog;
   - add a native splash, painted before the WebView exists.
4. **Idle RAM.** The WebView floor (~80–150 MB) is the price of sharing the
   renderer with the web app. The lever is a native renderer (wgpu): a
   different product with a different maintenance cost. It is not proposed
   unless the HP numbers show it matters to users.
