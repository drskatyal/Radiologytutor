# FlowRad Viewer vs RadiAnt DICOM Viewer

_The desktop app is now **FlowRad Viewer** (formerly "RadLearn Viewer"); RadLearn is the teaching mode and cloud._

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
`desktop/scripts/bench.mjs` there (§1.6). That is the next measurement owed.

**Release build.** `npx tauri build --no-bundle`, LTO, `opt-level=3`.

| metric | RadLearn Viewer (this box) | how |
|---|---|---|
| Installer, Linux `.deb` | **5.85 MiB** (M3 build, PACS and sync included) | `tauri build --bundles deb` |
| App binary (renderer, every codec and WASM embedded) | **11.6 MB** uncompressed (11.0 MB at M1) | `ls -l target/release/radlearn-viewer` |
| Cold start → painted start screen | **0.81–0.85 s** median of 6 (M1: 0.81 s; M3: 0.85 s) | `bench.mjs coldstart` |
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

### 1.5 MPR, 3D and fusion build times (M2)

Same box, release build. The timer runs from the MPR, 3D or fusion click to
every slice loaded and every pane drawn (`RADLEARN_BENCH_VIEW`).

| view | study | ready in |
|---|---|---|
| MPR (3 planes + 3D) | CT, 300 × 512² | **2.0 s** |
| 3D volume rendering | CT, 300 × 512² | **1.9 s** |
| PET/CT fusion (3 fused planes + PET MIP) | CT 300 + PET 75 | **2.5 s** |
| MPR | CT, 1,200 × 512² (600 MB) | **8.3 s** (4.3 s after the speed pass, §1.5.1) |

RadiAnt's published claim, for reference: a coronal MPR from more than 2,000
axial CT slices in about 3 s on a modern Core i7. That is a vendor claim, not
our measurement.

**What we fixed on the way.** Attaching a streaming volume to the viewports
before it was full made every decoded slice re-render every pane, the 3D ray
cast included. On software GL that took **67 s** for 300 slices. Building the
volume first and then attaching it takes **2.0 s**. A progress chip shows the
percentage while it builds.

**The next lever for 1,000+ slice studies.** Assemble the volume in Rust:
read and decode in parallel, then hand the renderer one buffer through a raw
IPC body, instead of 1,200 protocol requests and worker decodes. That is M3
work if the HP numbers show a gap.

### 1.5.1 Speed pass after M3 (same box, release build)

| | before | after | what changed |
|---|---|---|---|
| MPR ready, CT 1,200 × 512² | 8.3 s | **4.3 s** | decode pool's prefetch lane 8 → 32, retrieval pool 8 → 32, and decode workers = every core (desktop has no server to protect) |
| MPR ready, CT 300 × 512² | 2.0 s | **1.37 s** | same |
| **Anything on screen** after opening a CT | ~0.72 s | **0.13–0.16 s** | Rust renders a windowed PNG of the first slice in **2.7 ms**, served at `dicom://…/p/<id>`, shown until Cornerstone paints |
| Series hung (browser populated) | ~0.39 s | **0.04 s** | the engine is no longer parsed on the main thread while the scan runs; it starts once the preview is up |
| Full interactive viewport | ~0.72 s | 0.72 s | unchanged: Cornerstone init (~350 ms on software GL) is the floor here |
| Startup JS chunk | 577 KB | **437 KB** | toolbar, viewports, MPR/3D and every dialog load on demand |

Trade-offs, stated:
- **Compressed series** (J2K, JPEG, RLE…) have no Rust preview, and reach the full viewport ~60 ms later than before (0.88 s vs 0.82 s), because the engine now starts at hang time instead of at scan start.
- **Cold start** is unchanged at ~0.80 s. WebKitGTK spends ~0.68 s before our JS runs; our own share is ~0.12 s.

**Tried and dropped: assembling the whole volume in Rust.**
- **The upside:** Rust read and rescaled a 300-slice CT (150 MB) in **90 ms**.
- **The transfer cost:** handing that buffer to the WebView cost **2.6 s** through WebKitGTK's custom scheme (~60 MB/s). That would make a 1,200-slice study slower than streaming. A 150 MB IPC response was worse still.
- **A second problem:** Cornerstone's `createLocalVolume` then stalled.
- **Verdict:** reverted rather than shipped. Worth re-testing on WebView2 and WKWebView, whose custom-scheme throughput may be far higher, once the HP and a Mac are available.

### 1.5.2 Fix pass after the first HP results (v0.1.0 → this build)

**First real-hardware numbers.** These are v0.1.0 on Sanyam's HP (Core Ultra 7 256V, 16 GB, Windows 11):

| | measured |
|---|---|
| Cold start | 520 ms first run; 1.29 s on a later run, while memory was being sampled |
| Idle, whole process tree | ~400 MB working set, ~205 MB private (7 processes) |
| CT first slice | 1.21 s; reopened 0.68 s |
| MPR build | 3.97 s, peak 3.3 GB private |
| MRI, 10,310 files | scan 15.8 s, of which 15.2 s parsing |
| Normal launch with a study argument | **main viewport blank (P0)** |

**Same Linux box before and after** (4 cores, Xvfb, software GL), v0.1.0 against this build. The study is a synthetic CT: 4,333 files, 17 series, an 848-slice largest series, 2.2 GB, plus one stray non-DICOM file.

| | v0.1.0 | this build | what changed |
|---|---|---|---|
| Header parse, 4,333 files (cold) | 1,069 ms | **841 ms** | one open per file (magic, stat and parse on one handle) on a dedicated pool with 2× the cores. On Windows each open also pays an antivirus callback, so the gain there should be larger. |
| Scan done | 1,297 ms | **1,035 ms** | same |
| First image visible (Rust preview) | 159 ms | **121 ms** | |
| First full-fidelity frame | 948 ms | **845 ms**, *verified non-blank* | the check samples on Cornerstone's render event, not after fixed frames |
| Reopen (scan cache), scan done | 256 ms | 247 ms | |
| Cold start, median of 5 | 802 ms | **742 ms** | toasts (Radix + framer-motion, ~⅓ of the start bundle) load on first use; render no longer waits for protocol init; static splash |
| Idle tree, private, after 8 s | 143 MB | **131 MB** | Linux has no WebView2 memory-target knob |
| MPR 848 × 512², build | 3.9 s | 3.4–3.8 s | |
| MPR peak, tree private | 2.33 GB | 2.38 GB (settled: 2.21 → 2.21 GB) | **No change on this box.** The decoded cache is 425 MB of Int16. The rest is the WebGL texture and the driver's copies under software GL. **Must be measured on the HP.** |

**Fixed.**
- **P0, blank viewport.**
  - After the first render of each series, the app samples the on-screen canvas. If it is blank while the image has contrast inside the window, it switches to CPU rendering and draws again.
  - "First paint" now means real pixels on screen.
  - The fallback was tested by forcing the GPU sample blank: both CT variants recovered via `cpu-fallback`.
  - `desktop/scripts/e2e-paint.py` asserts non-blank pixels after a **normal** launch, and also in bench mode. It runs on Linux and on a new **windows-latest (WebView2)** CI job. Both pass on the GPU path. The fixture matrix also asserts it.
- **Bench never hanging.**
  - The shell prints `RADLEARN_BENCH_SCAN` the moment a scan ends.
  - Paint is a separate field, `paint.{firstImagePaintedMs,timedOut,visibility}`; the renderer waits at most `RADLEARN_BENCH_PAINT_TIMEOUT_MS`.
  - A watchdog, `RADLEARN_BENCH_TIMEOUT_MS`, prints what is known and exits with status 3.
  - A stray non-DICOM file is rejected by its magic bytes on the same single open, so it cannot stall the scan (the synthetic study above includes one).
- **Decoded-image memory is now honest.**
  - Cornerstone v5's default loader keeps every file's full bytes in a metadata store that is never evicted.
  - The desktop now uses the dataset path and trims each dataset to its header once decoded: 432 MB released on the 848-slice series.
  - The 2D cache has a 1 GB LRU budget.
  - All 21 codec checks are still bit-exact, the 18 fixtures paint, and MPR, 3D and fusion all build.
- **Windows idle footprint (needs the HP to confirm).**
  - WebView2 `MemoryUsageTargetLevel=Low` while nothing is open.
  - WebView2 arguments: no spare renderer, `--renderer-process-limit=1`, no background networking or component updates.
  - `bench.mjs` now reports the **whole process tree** on Windows (working set and private bytes per process, with each process's `--type`), plus the peak during a run.

**Merge gates: honest status.**

| gate | status |
|---|---|
| Cold start < 500 ms | **Not met on this box** (742 ms; WebKitGTK alone takes ~0.6 s before our JS). Needs the HP. |
| First image < 300 ms | **Met for the instant preview** (121 ms). The full Cornerstone frame is 845 ms here. |
| 60 fps scroll | **Not yet measured.** |
| MPR < 1.5 s and < 1.2 GB | **Not met on this box** (3.4 s, 2.4 GB under software GL). Needs the HP's GPU. |

### 1.6 Measure it on the HP (owed)

```powershell
npm ci; npm ci --prefix desktop
npm --prefix desktop run tauri build -- --no-bundle
node desktop/scripts/bench.mjs coldstart desktop\src-tauri\target\release\radlearn-viewer.exe --runs 6
node desktop/scripts/bench.mjs idle desktop\src-tauri\target\release\radlearn-viewer.exe --seconds 8   # whole WebView2 tree
python desktop\scripts\e2e-paint.py desktop\src-tauri\target\release\radlearn-viewer.exe C:\path\to\real-ct
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
| **Installer** | setup.exe (~7 MB), 9.8 MB installed | ✅ `.msi` + `.exe` (NSIS, per-user), universal `.dmg`, `.AppImage` + `.deb`, all from `.github/workflows/desktop-release.yml`. **`.deb` measured at 5.85 MiB.** Windows and macOS sizes come from the first CI run |
| **Auto-update** | ? | ✅ Tauri updater with an Ed25519-signed `latest.json` on GitHub Releases. Checks 8 s after launch (can be turned off), always asks, never installs silently. Offline or unsigned builds say so plainly |
| **Open: folder / files / drag-drop** | ✅ | ✅ including OS drag-drop, "Open with…" and command-line paths |
| **Open: DICOMDIR** | ✅ also builds thumbnails from it | ✅ index-driven, case-insensitive, ISO 9660 `;1` tolerant, falls back to a walk when the index is stale |
| **Open: zip** | ✅ including encrypted (prompts for password) | ✅ unencrypted. Encrypted archives get a clear message. Extracted once into the cache, zip-slip safe |
| **Open: CD/DVD** | ✅ Ctrl+Alt+O | ✅ Ctrl+Alt+O. Drives auto-detected on all three OSes, and DICOMDIR flagged |
| **PACS: C-FIND / C-MOVE / C-GET / C-STORE** | ✅ | ✅ **DIMSE:** C-ECHO, C-FIND (study root) and C-MOVE into a built-in storage SCP. ✅ **DICOMweb:** QIDO-RS search and WADO-RS retrieve, 8 instances in parallel. Both verified against a live Orthanc: 135 instances retrieved over WADO-RS in ~5 s, opened as a local study. C-GET and push to PACS: not yet |
| **Progressive display while loading** | ✅ "images can be browsed while still being opened" | ✅ the scanner streams headers and the first series hangs at once |
| **Transfer syntaxes** | JPEG baseline/lossless, JPEG-LS, J2K, RLE, deflate; HTJ2K? | ✅ **all of these, HTJ2K included**: 10/10 syntax fixtures plus multiframe verified in the real app |
| **Multiframe / cine** | ✅ | ✅ frame rate read from FrameTime / RecommendedDisplayFrameRate |
| **DICOM video (MPEG-2/H.264)** | ✅ | ✖ not yet |
| **Series browser with thumbnails** | ✅ | ✅ decoded thumbnails at low priority, drag onto any viewport |
| **Study history / local database** | ✅ database, keywords, CSV | 🟡 searchable recent studies (description, modality, date, folder; no PHI), an instant re-open cache, and a PACS retrieve cache. **A managed local archive is not built yet:** no import-into-library, keywords or CSV |
| **Layouts** | multiple series and windows | ✅ 1×1 to 3×3, maximise a cell (Enter or double-click), hang by drag-and-drop |
| **Side-by-side compare** | ✅ | ✅ any series in any cell, across studies |
| **Synchronised scrolling** | ✅ automatic within a plane | ✅ F5, position-based, works across series and studies sharing a frame of reference |
| **Reference lines** | ✅ | ✅ Ctrl+F12 |
| **3D cursor** | ✅ | ✅ MPR crosshairs: click any plane and the others jump to that point |
| **W/L, presets, custom WW/WL** | ✅ Ctrl+F11 | ✅ right-drag, 1–9 modality presets, Ctrl+F11 dialog, invert |
| **Zoom / pan / rotate / flip** | ✅ | ✅ including RadiAnt's Ctrl+0–4 zoom levels and Ctrl+arrow pan |
| **Length, angle, Cobb** | ✅ | ✅ |
| **Ellipse ROI with stats** | ✅ mean/min/max/area/SD | ✅ same stats, in HU |
| **Rectangle / circle / freehand ROI** | polygon ✅, rectangle ? | ✅ rectangle, circle, freehand |
| **Probe, arrow, bidirectional, magnifier** | arrow ✅, pen ✅ | ✅ all four |
| **MPR (orthogonal / oblique)** | ✅ | ✅ axial, sagittal and coronal with linked crosshairs. Drag a line for an oblique plane. Colour-coded planes |
| **MIP / MinIP / average slab** | ✅ | ✅ 1–60 mm slab, with slab bounds drawn on the crosshairs |
| **3D volume rendering** | ✅ | ✅ 11 presets (CT bone, chest contrast, soft tissue, lung, AAA, cardiac, MIP, muscle, MR default, angio and MIP). Opens like a radiograph; trackball rotate |
| **PET-CT fusion with SUV** | ✅ | ✅ SUVbw computed from the dose, timing and weight tags. Three fused planes plus a coronal PET MIP; colormap, opacity and SUV window controls. Falls back to raw values, labelled as such, when the tags are missing |
| **Time-intensity curves** | ✅ | ✖ not planned |
| **Export JPEG / PNG** | JPEG, BMP | ✅ PNG and JPEG for one image or a whole series. Annotations optional; text overlay anonymous by default |
| **Export video** | WMV, MP4 | ✅ MP4 (H.264 via WebCodecs) where the OS provides an encoder, otherwise Motion-JPEG AVI. Both faster than real time |
| **Export DICOM, anonymised** | ✅ (anonymisation is a paid add-on) | ✅ **free**: PS3.15 basic-profile header scrub, private tags removed, consistent UID remap, compressed pixel data kept byte-for-byte. Verified on all 10 transfer syntaxes and re-opened |
| **Printing** | ✅ (2025.1) | ✖ not planned |
| **Keyboard shortcuts** | ✅ | ✅ RadiAnt's documented keys plus a full sheet (F1) |
| **Teaching overlays / RadLearn hand-off** | ✖ | ✅ optional sign-in, then **Send to RadLearn**: anonymised here, posted to `/api/upload`, de-identified again by the server. Verified end to end against a local RadLearn + Orthanc (24/24 images arrived with an empty patient name and a remapped Study UID) |

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

1. ~~**M2:** MPR with linked crosshairs, MIP/MinIP slab, 3D VR, PET/CT
   fusion with SUV, export to PNG/JPEG/MP4/AVI and anonymised DICOM.~~
   **Done.** See §1.5 for timings.
2. ~~**M3:** installers and signed auto-update from CI, searchable history,
   DICOMweb + DIMSE query/retrieve, RadLearn sign-in and send.~~ **Done,
   with one exception:** the full local archive (import-into-library, keywords,
   CSV export) is still open.
3. **Owed, and needs hardware or accounts we don't have here:**
   - Re-measure on the HP (§1.6).
   - Run the WKWebView spike on a Mac (`docs/DESKTOP_PLAN.md` §1.1).
   - Add the signing identities:
     - Apple Developer ID, $99/yr;
     - Azure Artifact Signing, ~$10/month;
     - the updater key pair, from `npx tauri signer generate`, with the
       public key in the `TAURI_UPDATER_PUBKEY` variable.

     The release workflow already reads all three.
4. **Remaining feature gaps, by value:**
   - a managed local archive;
   - C-GET and push to PACS (C-STORE SCU);
   - DICOM video (MPEG-2/H.264);
   - curved MPR;
   - printing;
   - time-intensity curves.
5. **Startup and memory against the hard targets** (<0.5 s cold start; low
   idle RAM). The levers, in order, if the HP numbers miss them:
   - **Startup bundle.** Load framer-motion and Radix lazily behind the
     first dialog. Our share of startup is ~0.11–0.22 s here.
   - **Native splash.** Paint a native splash before the WebView exists, so
     the window appears at native speed.
   - **Idle RAM.** The WebView floor (~80–150 MB) is the price of sharing one
     renderer with the web app. Going below it means a native renderer
     (wgpu): a different product with a different maintenance cost. It is
     not proposed unless users show it matters.
