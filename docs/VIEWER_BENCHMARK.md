# Viewer benchmark — where FlowRad's viewer stands

Date: 2026-10-30. Written against `components/CornerstoneViewer.tsx`,
`lib/progressiveStack.ts`, `lib/viewerRuntime.ts`, `lib/prefetchPlan.ts`,
`lib/viewerWarmup.ts`, `lib/mpr.ts` on branch `claude/viewer-perf`.

Two jobs. First, record the numbers this branch actually moved, with a harness
anyone can re-run. Second, compare the viewer honestly against the open-source
viewers worth comparing to, and say in priority order what is missing before
this is a viewer a radiologist would install on purpose.

---

## 0. How to reproduce every number here

```bash
# Synthetic WADO-RS origin + headless Chrome driving the shipped loader.
node scripts/bench/run.mjs --slices 240 --latency 40 --metadata-build 400 --scroll 40 --repeats 3

# The real viewer UI in a real browser, against a running app.
npx next start -p 3123
node scripts/bench/smoke.mjs http://127.0.0.1:3123/cornerstone
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs \
  'http://127.0.0.1:3123/case/<caseId>?mode=view'
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs http://127.0.0.1:3123/viewer/local
```

`scripts/bench/run.mjs` serves a synthetic uncompressed 16-bit series shaped
exactly the way Orthanc shapes one (QIDO rows, per-instance metadata, a series
metadata document built in one shot, `multipart/related` frames, and the same
`Cache-Control` headers `lib/dicomwebProxy.ts` stamps), then drives the real
`lib/progressiveStack.ts` and the real Cornerstone stack viewport against it.
Each profile flips **one** thing relative to `baseline`, so the table
attributes the delta instead of merely reporting it. The harness asserts the
opening frame actually **decoded** (rows, columns, pixel count) — an image
whose metadata is missing still fires `IMAGE_RENDERED` on a blank canvas, and
without that assertion every number would be measuring an empty viewport.

### What the harness is not

- There is no Orthanc, no TLS, no R2 object cache and no WAN. Latency is a
  fixed per-request delay, not a real RTT distribution with congestion control.
- Headless Chrome here renders through **SwiftShader** (CPU), and Cornerstone
  logs `GPU not detected, using CPU rendering`. Absolute render cost is
  pessimistic, and **volume viewports do not work at all** — which is why MPR
  can only be verified to its fallback in this environment.
- The engine bundle is a local esbuild bundle, so `moduleMs` (~15 ms) is
  nothing like the ~1.0 MB gzipped the production app downloads. Where that
  matters the doc says so.

Numbers below are **best of 3** on an 8-core/15 GB Linux box. Treat them as
within-machine deltas, not as a vendor spec sheet.

---

## 1. What this branch moved

### 240-slice 512² CT, 40 ms per-request latency, 400 ms metadata build

| profile | first pixel | series ready | cold stack travel | QIDO bytes before first pixel |
|---|---|---|---|---|
| `baseline` (ships in 71c006a) | 145 ms | 596 ms | **49.2 ms/slice** | 21 KB |
| `+ engine knobs` only | 147 ms | 598 ms | 50.5 ms/slice | 21 KB |
| `+ travel prefetch` only | 144 ms | 595 ms | **11.2 ms/slice** | 21 KB |
| `+ instance-count hint` only | 145 ms | 598 ms | 48.8 ms/slice | **0.2 KB** |
| `+ pre-warm` only | **83 ms** | 535 ms | 49.1 ms/slice | 21 KB |
| **all of them (`tuned`)** | **83 ms** | **534 ms** | **10.7 ms/slice** | **0.2 KB** |

### 1200-slice 512² CTA, 40 ms latency, 1200 ms metadata build

| | first pixel | series ready | cold travel | QIDO bytes |
|---|---|---|---|---|
| `baseline` | 151 ms | 1423 ms | 49.0 ms/slice | 105 KB |
| `tuned` | 86 ms | 1357 ms | 10.1 ms/slice | 0.1 KB |

### 240-slice 1024² (2 MB/frame), 10 ms latency

| | first pixel | series ready | cold travel |
|---|---|---|---|
| `baseline` | 84 ms | 331 ms | 44.4 ms/slice |
| `tuned` | 72 ms | 293 ms | 17.6 ms/slice |

### Route payload

| route | before | after |
|---|---|---|
| `/viewer/local` first load JS | 890 kB route / 1.08 MB total | **8 kB route / 193 kB total** |

`lib/localDicomFiles.ts` imports `dicom-parser` and the Cornerstone loader on
first use instead of at module scope. The landing state of that page is a
dropzone; it must not ship a decoder before a folder is chosen.

### Reading the table honestly

- **Travel prefetch is the win.** `lib/prefetchPlan.ts` adds the rule the
  viewer was missing: while the reader is *moving*, warm a handful of slices in
  the direction of travel on every slice change. The old rule only fired after
  a 200 ms scroll pause, and a reader who holds the wheel never produces that
  pause — so every slice was a cold round trip. 4.6× at 512², 2.5× at 1024².
- **Pre-warm halves time to first pixel**, and it is *understated here*. In the
  harness the engine is a local bundle; in production the Cornerstone chunks
  are ~3.8 MB raw / ~1.0 MB gzipped across four chunks that only start
  downloading when the viewer mounts, and the opening frame's three round trips
  used to start after that. `components/viewer/ViewerPrewarm.tsx` overlaps them.
- **The engine knobs did not move these numbers, and the module header says so.**
  `maxWebWorkers` 4 → 6 showed no reliable gain on *uncompressed* frames,
  because little-endian decode is close to a memcpy. The change is for the
  transfer syntaxes a real archive stores — JPEG 2000, JPEG-LS, HTJ2K — which
  decode in WASM and are where worker count dominates. The cache ceiling
  (Cornerstone defaults to **3 GB** of decoded pixels) is a *memory-safety*
  change, not a speed one: 3 GB of ArrayBuffers is a dead tab on a 4 GB laptop,
  and the cache evicts LRU so a lower ceiling costs re-decodes, never
  correctness.
- **The instance-count hint is a bytes win, not a milliseconds win** at these
  sizes. Without a count the loader has to page the whole SOP list just to find
  a midpoint — 105 KB of JSON in front of the first pixel on a 1200-slice CTA.
  With one it is a single 1-row QIDO. On loopback that is ~0 ms; on a phone on
  cellular it is not.
- **`warm scroll` is not in the table.** Re-walking cache-hit slices completes
  in under a millisecond per slice in every profile, so the harness's
  slices/second figure there is measurement noise and reporting it would be
  dishonest.

### Live verification (real browser, real archive)

`scripts/bench/smoke.mjs` drives the real UI over the DevTools Protocol.

| target | result |
|---|---|
| `/cornerstone` (bundled 10-frame sample) | **13/13** |
| `/case/<lidc>?mode=view` (real 65-slice CT via Orthanc + `/api/dicomweb`) | **12/13** |
| `/viewer/local` (local file open) | **14/14** |

The one failure is MPR on the volumetric CT: headless SwiftShader has no WebGL
context for the volume pipeline (`no webgl context`, then a vtk.js
`get3DContext` throw), and the viewer takes its explained fallback — "This
series couldn't be reconstructed. The stack view stays on." That is the
**failure path verified on a real volumetric series**, which is worth having;
MPR *succeeding* has not been verified in this environment and needs a GPU.

---

## 2. Feature comparison

Scope note: this compares a *teaching* viewer to diagnostic workstations and to
general-purpose libraries. Several gaps below are deliberate. The ones that are
not are in §4.

| | **FlowRad** | **OHIF v3** | **Cornerstone3D examples** | **dwv** | **Weasis 4** | **OsiriX MD** | **MicroDicom** | **3D Slicer** |
|---|---|---|---|---|---|---|---|---|
| Delivery | web, self-hosted | web, self-hosted | library | library / web | desktop + web launch | macOS native | Windows native | desktop |
| Licence / cost | proprietary | MIT | MIT | GPL-3.0 | EPL-2.0 / Apache-2.0 | paid (CE/FDA) | free non-commercial | BSD-style |
| Engine | Cornerstone3D (WebGL) | Cornerstone3D (WebGL) | Cornerstone3D (WebGL) | canvas/JS | Java2D/VTK | native + VTK | native | VTK/ITK |
| Stack scroll · W/L · zoom · pan | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Window presets | ✅ per modality | ✅ viewport menu | example-level | ✅ | ✅ | ✅ | ✅ | ✅ |
| Slice scrollbar | ✅ *(this branch)* | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cine | ✅ *(this branch)* | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Keyboard control of the viewport | ✅ *(this branch)* | ✅ | ❌ | partial | ✅ | ✅ | ✅ | ✅ |
| Length / angle / ROI / probe | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3-plane MPR | ✅ lazy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 2026 | ✅ |
| MIP / thick slab | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 3D volume rendering | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ 2026 | ✅ |
| Hanging protocols / layouts | ❌ (fixed 1-up + compare) | ✅ first-class | n/a | ❌ | ✅ | ✅ | ✅ | partial |
| Reference lines / cross-series crosshairs | MPR only | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Magnify glass | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | — |
| DICOM SEG / RTSTRUCT display | ❌ | ✅ | ✅ | ✅ (SEG) | ✅ | ✅ | partial | ✅ |
| Structured Report / PR / KOS | ❌ | ✅ (SR) | — | ✅ (SR) | ✅ | ✅ | partial | partial |
| PET/CT fusion + SUV | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Segmentation editing | ❌ | ✅ (incl. AI-assist) | ✅ | ✅ basic | partial | ✅ | ✅ basic | ✅ best-in-class |
| DICOM tag browser | ❌ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Local file / folder / DICOMDIR open | ✅ *(this branch; DICOMDIR detected, not parsed)* | ✅ local mode | ✅ example | ✅ | ✅ | ✅ | ✅ | ✅ |
| DICOM Q/R networking (C-FIND/MOVE/GET) | ❌ (DICOMweb only) | ❌ (DICOMweb only) | ❌ | ❌ | ✅ | ✅ | ❌ | partial |
| DICOMweb QIDO/WADO/STOW | ✅ (proxied, org-scoped) | ✅ | ✅ | ✅ (WADO) | ✅ | partial | ✅ 2026 | partial |
| Export JPEG / MP4 / STL | internal only | ✅ | — | ✅ (PNG) | ✅ | ✅ | ✅ | ✅ |
| Progressive / HTJ2K streaming retrieval | ❌ (see §3) | ✅ | ✅ | ❌ | ❌ | n/a | ❌ | n/a |
| Narrated multi-step teaching walk-through | ✅ **unique** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Record → exact replay of viewer state | ✅ **unique** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Voice Q&A tutor on the pixels | ✅ **unique** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Click-the-finding assessment | ✅ **unique** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| De-identification gate on ingest | ✅ | n/a | n/a | n/a | ✅ (tool) | ✅ | ✅ | ✅ |
| Diagnostic clearance | ❌ never claimed | ❌ | ❌ | ❌ explicitly not | ❌ (CE-marked builds exist) | ✅ | ❌ | ❌ research |

Two market facts worth recording, because they change the case for §5's
desktop plan:

- **Horos is gone.** HorosProject.org is permanently closed and Horos has been
  withdrawn from distribution ("R.I.P. Horos, 2015–2025"), with the OsiriX
  project directing former users to paid OsiriX MD. The free, well-known
  macOS standalone viewer no longer exists.
- **MicroDicom only ships on Windows**, and only free for non-commercial use.
  3D Slicer is cross-platform and free but is a research platform, not a
  "open this CD" viewer.

So the obvious free cross-platform "read the disc the hospital gave me" slot is
genuinely open.

---

## 3. Performance techniques, and which of them we use

| technique | who does it | FlowRad | note |
|---|---|---|---|
| Decode in web workers (WASM codecs) | all CS3D viewers | ✅ | `lib/viewerRuntime.ts` sizes the pool to the device |
| Device-aware cache ceiling | few | ✅ *(this branch)* | library default is 3 GB |
| One WebGL context pool, shared engine | CS3D | ✅ | `SHARED_RENDERING_ENGINE_ID`; `isMobile` drops 7 contexts → 1 |
| Native 16-bit textures (`norm16`), avoid float widening | CS3D | ✅ | `preferSizeOverAccuracy` on mobile only |
| Streamed, incrementally-parsed series metadata | rare | ✅ | `lib/jsonArrayStream.ts` + `lib/progressiveStack.ts` |
| Open the first frame off a single instance's metadata | rare | ✅ | the point of #67 |
| Known-count midpoint instead of paging the SOP list | — | ✅ *(this branch)* | 105 KB → 0.1 KB on a 1200-slice CTA |
| Direction-of-travel prefetch while scrolling | every PACS | ✅ *(this branch)* | the single biggest measured win |
| Series-length-aware pause prefetch radius | few | ✅ *(this branch)* | whole series ≤ 64 frames, else a window |
| Warm the engine bundle before the viewer mounts | — | ✅ *(this branch)* | ~1.0 MB gz off the critical path |
| Warm the opening frame via the HTTP cache | — | ✅ *(this branch)* | same URL + same `Accept`, so the viewer's request is a hit |
| `immutable` cache headers on frames + instance metadata | — | ✅ | `lib/dicomwebProxy.ts` |
| Object-store frame cache in front of the archive | — | ✅ | `lib/r2.ts` behind a 25 ms budget |
| Memoised authorization on the frame path | — | ✅ | `lib/ttlMemo.ts`; this branch also removed a **double** session resolution per frame |
| Wide interaction request pool | Google's guidance | ✅ | 16 on desktop, 6 on mobile |
| **HTJ2K progressive / streaming retrieval** | OHIF, CS3D | ❌ | §3.1 |
| **Byte-range two-stage lossy→lossless retrieval** | OHIF, CS3D | ❌ | §3.1 |
| **Interleaved volume retrieval** (every 4th slice first) | OHIF, CS3D | ❌ | our MPR builds the volume eagerly |
| Server-rendered thumbnails for the series rail | OHIF, Weasis | partial | the rail uses `/rendered`, the stack does not |
| Shared-array-buffer zero-copy decode handoff | CS3D (where available) | ❌ untested | needs COOP/COEP headers |
| HTTP/3 / multiplexed frame fetches | CDN-dependent | ❌ | Cloud Run terminates HTTP/2 |

### 3.1 The progressive-retrieval gap, concretely

Cornerstone3D already *contains* the machinery we are not using. The installed
`@cornerstonejs/core@5.0.10` ships `loaders/ProgressiveRetrieveImages`,
`utilities/imageRetrieveMetadataProvider`, and three stage configurations
(`singleRetrieve`, `sequentialRetrieve`, `interleavedRetrieve`); the installed
`@cornerstonejs/dicom-image-loader@5.0.10` `getPixelData` already honours
`retrieveOptions.streaming`, `rangeIndex`, `urlArguments` and `framesPath`, and
`loadImage` treats `1.2.840.10008.1.2.4.202` / `.203` / `3.2.840.10008.1.2.4.96`
as streamable. Turning it on is configuration, not a port.

What is missing is the **server side**. Cornerstone's own guidance is blunt
about it: HTJ2K "is not yet widely supported by DICOMweb servers," and
progressive support "varies significantly among DICOMweb implementations."
Streaming needs HTJ2K **RPCL**; the byte-range path needs HTTP Range on frames.

For our two backends:

- **Orthanc** can transcode in WADO-RS, and `HasWadoRsUniversalTransferSyntax`
  lets `transfer-syntax=*` through (which is what our proxy already forces, and
  which avoids a pointless transcode to uncompressed). But for WADO-RS bulk
  data "only range queries that return entire bulk data objects are supported"
  — i.e. no partial frame ranges — and HTJ2K is not a syntax we can rely on it
  producing.
- **Cloud Healthcare API** supports `transfer-syntax=*` to disable transcoding
  and can transcode frames to other formats, with documented limits (it cannot
  transcode non-monochrome >8-bit to JPEG).

So the realistic order is: **store HTJ2K RPCL at ingest** (we own
`orthancIngestInstance`, and we already de-identify there, so we are already
rewriting every instance) → then enable `streaming: true` with a single-stage
retrieve configuration. That is the one change that would make a 3000×3000
image interactive in tens of milliseconds: Cornerstone's own measurement on a
3036×3036, 11.1 MB image over 4G is **66 ms to first render** with HTJ2K
streaming (5053 ms to final) and **45 ms** with a two-stage byte range
(4610 ms to final), against a baseline that has nothing to show until the whole
11 MB has landed.

---

## 4. Prioritised gap list

Ordered by how much a radiologist would feel it, with the cost of closing it.

### P0 — the viewer is not credible without these

1. **Reference lines and a cross-series cursor.** Comparing a prior and a
   current, or a stack and its MPR, without a line showing where the other
   viewport is, is guessing. Cornerstone3D ships `ReferenceLines` and
   `CrosshairsTool`; the blocker is that we have no "active viewport" notion
   (`docs/UI_AUDIT.md` backlog #7). *Medium — needs the active-viewport model.*
2. **DICOM tag browser.** Every viewer in §2 has one; we have none. A teacher
   cannot answer "what kernel was this?" and a bug cannot be diagnosed from a
   screenshot. We already hold the full per-instance metadata in
   `wadors.metaDataManager`. *Small.*
3. **HTJ2K at ingest + `streaming: true`.** §3.1. The largest single
   latency lever left, and the library side is already installed. *Medium —
   transcode in the ingest seam, then a retrieve configuration.*
4. **Magnify.** A 1-px nodule on a 512² image shown at 400 px needs it.
   Cornerstone3D ships `MagnifyTool`. *Small.*

### P1 — expected of a real reading surface

5. **Thick slab / MIP on the MPR planes.** Our MPR gives three thin planes; a
   reader looking for a nodule wants a 10 mm slab MIP. The volume already
   exists once MPR is on. *Small-medium — a blend mode and a slab thickness.*
6. **Layouts beyond 1-up and 2-up compare.** No 2×2, no "prior left, current
   right, both scrolled together". This is OHIF's hanging-protocol model and
   also needs the active-viewport notion. *Medium.*
7. **Interleaved volume retrieval for MPR.** Entering MPR currently loads every
   slice before anything appears. `interleavedRetrieve` shows a coarse volume
   almost immediately. *Small — a configuration, once P0.3's plumbing exists.*
8. **Export.** One frame as PNG/JPEG, the loop as MP4. We have
   `captureViewportStill` and `captureViewportStream` internally for author
   compile; they are not user-facing. *Small.*
9. **DICOMDIR parsing.** `lib/localStudy.ts` *detects* DICOMDIR and ignores it
   because we read every file anyway. That breaks on media where the index is
   the only way to find the images. *Small.*

### P2 — differentiators and completeness

10. **DICOM SEG / RTSTRUCT display.** Needed the moment anyone wants to teach
    from an AI output or a radiotherapy plan. Cornerstone3D supports it.
    *Medium.*
11. **Structured Report display.** Reading a real report beside the images is
    exactly our teaching use case. *Medium.*
12. **PET/CT fusion with SUV.** Opens oncology teaching, which we cannot do at
    all today. *Large.*
13. **Shared-array-buffer decode path.** Requires COOP/COEP on every response,
    which would break third-party embeds; measure before committing. *Medium.*

### P3 — deliberately not doing

- **DICOM Q/R networking (C-FIND/C-MOVE).** A browser cannot speak DICOM
  upper-layer protocol. It belongs to the desktop build if anywhere
  (`docs/DESKTOP_PLAN.md` §7), not to the web viewer.
- **Diagnostic clearance.** We are a teaching product and must never imply
  otherwise. dwv states this plainly and so should we.
- **Segmentation editing.** 3D Slicer is better at this than we will be, and
  our assessment story is click-the-finding, not contour-the-organ.

### Still open from `docs/UI_AUDIT.md`

This branch closed backlog **#2** (slice scrollbar), **#3** (tool shortcuts;
the *keyboard-navigable menu widget* half is still open — the toolbar menus
remain pointer menus), and **#10**'s cine. Backlog #1, #4, #5, #6, #7, #8, #9,
#11 are untouched and still accurate.

---

## 4a. Reading-room feel — `claude/viewer-ux` (2026-10-31)

The perf branch made the viewer fast. This pass makes it feel like a PACS a
radiologist reaches for on purpose. Compared against OHIF v3 (open source, read
directly), Pacsbin (the share-link teaching viewer we are closest to in use),
and Stradus. **Honesty note on Stradus:** we could not find public feature or
shortcut documentation for it; a search mostly returns Optum's *Stratus* PACS,
whose published key map (W window/level, I invert, Z magnify, F11 fullscreen,
Backspace for comparison exams, `]` next protocol) is the kind of single-letter
reading-room keyboard we benchmarked against. Rows below marked "convention"
are the conventions those workstations share, not verified Stradus facts.

| | Before | After (`claude/viewer-ux`) | OHIF v3 | Pacsbin | Reading-room convention |
|---|---|---|---|---|---|
| Toolbar | captions, group headings, a "Left button: …" line; 44–48 px wrapping rows | one quiet row on `#000`, light icons, one accent; dividers, no captions | labeled primary bar + More | minimal icon bar | dense, keyboard-first |
| Shortcut discoverability | digits only, in a session cheatsheet | tooltip names every key; `H` / `?` sheet in the pane; student sheet reads the same table | hotkeys page in preferences | — | printed key map |
| Letter shortcuts | none | W S Z M L A E B, I, O, X, G, K, `, .` | yes (configurable) | — | yes (W, I, Z …) |
| Press feedback | 500 ms ease on shared buttons | 75 ms scale + fill on press; on-image HUD confirms key actions ("Lung  W 1500 L −600") | button state only | — | OSD text |
| Menus | pointer-only `div role=menu` | Radix menus: arrows, typeahead, Escape, fullscreen-safe portal | Radix-style menus | — | — |
| Corner overlay | one boxed pill: slice + W/L | four corners (series, image, thickness/location, window + preset, zoom, matrix) + orientation letters; `O` cycles full → basic → off; PHI impossible by type | customizable overlay | basic | four-corner text, toggleable |
| MPR | three planes, small grey labels | plane names in their crosshair color, orientation letters per plane, overlay toggle hides them | crosshairs, colored | — | colored reference lines |
| Hanging layouts | 1-up + compare | 1×1 / 1×2 / 2×1 / 2×2, `G` cycles, one shared toolbar follows the active pane | hanging protocols | layouts on roadmap | protocols |
| Share the exact view | share link opens slice 1 | **View link**: series, image, window, layout in the URL; share links carry it too | URL params (study level) | public links | — |
| Double-click | nothing | fit image to pane | — | — | fit / 1:1 |
| Fullscreen | floating labeled button over the top-right of the image | in the toolbar (`F`); nothing floats over the overlay | toolbar | — | F11 |

**Verified in this environment for the first time:** MPR *succeeds* under
headless Chrome with `--use-angle=swiftshader --enable-unsafe-swiftshader`
(§1 said it needed a GPU). `scripts/bench/phantomOrthanc.mjs` is a phantom
archive (synthetic chest CT, three series, no patient tags) that stands in for
Orthanc so the real UI can be driven and photographed:

```bash
node scripts/bench/phantomOrthanc.mjs --port 8042 --study <case study UID> --series <case series UID>
ORTHANC_URL=http://127.0.0.1:8042 DEMO_AUTH_ENABLED=1 BETTER_AUTH_SECRET=… npx next start -p 3123
```

**Still not done** (and still in §4): reference lines across non-MPR panes,
synchronized scroll between panes, magnify, rotate/flip (left out on purpose
until the record stream can replay them), thick-slab MIP, and a wheel model
that lets a sustained trackpad gesture exceed ~12 slices/s
(`lib/scrollSensitivity.ts` caps it to fix the one-notch-many-slices bug — needs
a real trackpad to retune, not a headless guess).

## 6. Production test round — `claude/viewer-speed` (2026-11-01)

A real test of the production viewer (Cloud Healthcare backend) reported: an
848-slice CT took ~90 s to load, each GCP frame ~620 ms regardless of
parallelism, a 9.5 MB series metadata document, duplicate fetches on open,
uncompressed JSON, the wheel skipping ~2 slices, and a set of UX bugs.

### Rig (reproducible, no production access needed)

```bash
node scripts/bench/phantomOrthanc.mjs --port 8042 --slices 848 --matrix 512 \
     --latency 620 --meta-pad 10000 --warm 1 --study <uid> --series <uid>
ORTHANC_URL=http://127.0.0.1:8042 DEMO_AUTH_ENABLED=1 DICOMWEB_FRAME_TRANSFER_SYNTAX=jls npx next start -p 3123
node scripts/bench/h2proxy.mjs --port 8443 --target http://127.0.0.1:3123   # HTTP/2 like production
node scripts/bench/viewerLoad.mjs  --mbps 40 --slices 848                  # the real viewer page
node scripts/bench/seriesFetch.mjs --mbps 40 --concurrency 24 --repeat 1   # wire cost of the series
node scripts/bench/s3stub.mjs --port 9000                                  # object-store tier, locally
```

The phantom serves 848 × 512² 16-bit CT frames with **620 ms per request**
and ~11 KB of metadata per instance (9.68 MB series document, matching
production). **40 Mbit/s** is the downlink that reproduces production's 90 s:
445 MB of raw frames ÷ 90 s ≈ 5 MB/s. That is the key finding — the 90 s was
**bandwidth-bound**, not latency-bound, so bytes (JPEG-LS) and caching are the
levers; concurrency only removes the 620 ms floor.

### Before → after (same rig, same machine)

| | before | after |
|---|---|---|
| Whole 848-slice series over the wire, 40 Mbit/s, cold | **90.9 s**, 445 MB | **33.2 s**, 124 MB |
| …second reader (server cache warm) | 91.3 s (no cache) | **25.7 s** (`X-Cache: HIT` ×848) — the 40 Mbit/s floor for 124 MB |
| …object-store tier only (S3 stub, memory tier off) | — | 25.8 s, 848 PUT / 848 HIT |
| Viewer loads the whole series by itself, 40 Mbit/s | never (only ±window; MPR load **stalled at 244/848**) | **24.6 s** (outward fill) |
| Viewer whole series, unthrottled HTTP/2 | 22.6 s, MPR only | **11.8 s**, on open |
| First pixel, unthrottled | 4.6 s | **3.8 s** |
| First pixel, 40 Mbit/s | 7.1 s | **3.6 s** |
| One frame, archive miss → server cache hit | 651 ms → 651 ms | 651 ms → **6 ms** |
| Bytes per 512² CT frame | 524 KB (as stored) | **148 KB** JPEG-LS lossless (3.5×; GCP measured 3.2×) |
| Series metadata on the wire | **9.68 MB** JSON, uncompressed | **22 KB** (1.17 MB slim index, gzip); cache hit 5 ms |
| Requests on open: 1-row QIDO / instance metadata / rail instance lists | 2 / 2 / 5 | **1 / 1 / 3** |
| Wheel, two quick notches on a cold stack | n → n+2 (n+1 never painted) | n → n+1 → n+2 |

The asked-for ~21 s needs either the cache warm **and** a link faster than
40 Mbit/s (124 MB at 50 Mbit/s ≈ 20 s), or the converted-bundle path (#79:
HTJ2K + 8-bit previews on a CDN), which is already in the tree and turns on
with `DICOM_CDN_*`.

### What changed

- **Transfer syntax** (`lib/frameTransfer.ts`): when the loader asks for
  "whatever is stored", the proxy asks Cloud Healthcare for lossless JPEG-LS
  (`DICOMWEB_FRAME_TRANSFER_SYNTAX`, default `jls` on Healthcare). The part's
  Content-Type carries the syntax; Cornerstone decodes it with CharLS in its
  worker pool. A 400/406/415/501 falls back to the stored syntax and is
  remembered per series for 10 min. *GCP's frame transcoding list could not
  be fetched from this sandbox — the fallback is what makes that safe; verify
  `X-Frame-Syntax: jls` on production.*
- **Frame cache** (`lib/frameCache.ts`): in-process LRU (L1, 64 MB default) in front
  of R2/GCS (L2). The old 25 ms *budget* meant a real bucket (30–80 ms)
  almost never won; reads are now *hedged* (archive starts after the hedge
  window, a later cache hit still wins). `X-Cache: HIT | MISS | BYPASS`,
  `X-Cache-Tier: memory | object` on every response.
- **Slim series index** (`lib/dicomMetaSlim.ts`): series metadata cut to the
  tags Cornerstone's wadors provider reads (a test diffs the list against the
  installed loader), cached, gzip on the wire. Patient name/ID/birth date and
  accession are not in it.
- **gzip/brotli** for every other JSON body from `/api/dicomweb`.
- **Load outward** (`lib/seriesFill.ts`): after the opening ±10, the rest of
  the series queues nearest-first at prefetch priority, bounded by the
  decoded cache. Pools: 24 prefetch / 32 interaction on desktop (HTTP/2),
  6 / 8 on phones. Never re-centred by clearing the queue — a cleared request
  leaves Cornerstone's load object pending forever.
- **Duplicates**: the prewarm and the viewer share in-flight JSON
  (`lib/sharedJsonFetch.ts`), the standalone viewer opens on the slice the
  prewarm warmed (it opened mid-stack, throwing the warm away), the series
  rail memoises per series, and share links now prewarm too.
- **Wheel**: Cornerstone's `debounceIfNotLoaded` merged two steps into one
  jump while a frame was in flight; it is off, and ±10 prefetch keeps steps
  local.

### UX fixes, verified in the browser

| bug | cause | check |
|---|---|---|
| MPR crosshair doesn't link views | `getReferenceLineDraggableRotatable: () => false` — CrosshairsTool only moves viewports whose lines are controllable **and** draggable-rotatable | click in sagittal → axial 65 → 318 |
| no 3D / MIP | — | `Stack · MPR · MIP · 3D`; MIP = 15 mm max-intensity slab; 3D = VOLUME_3D with CT-Bone / MR preset, trackball rotate |
| arrows / PgUp / PgDn don't scroll | Cornerstone's mousedown `preventDefault` stopped the image taking focus; MPR hid the focused element and dropped focus to `<body>` | ↓ +1, PgDn +42 after a click; arrows scroll the touched MPR plane |
| Escape doesn't close compare | not wired | closes |
| hidden blank viewport behind MPR | `disableElement` left the stack's full-size canvas in the DOM | 0 hidden canvases in MPR |
| MPR axial black side bars | full-width axial row | wide panes: axial 2/3 left, coronal/sagittal right |
| tutor bar ~20 % of height | caption card + dots + mode + mic + hint, stacked | one line, 53 px (5.9 %) |
| compare repeats the toolbar | one bar per pane | one shared bar, follows the outlined pane |
| a 401 on load | `/api/me` answered 401 for "signed out" | 200 `{user:null}`; signed-out viewer shows "Sign in to view the images" |
| (found) 401 burst after a cold start | the pixel gate cached a failed session lookup for 10 s | `null` is never cached when an auth cookie is present |

## 5. One thing we found that is worth not forgetting

`lib/prefetch.ts`'s `buildPrefetchManifest` returns series order with
`hasImaging: false` and empty `instances` **by design** — enumerating every
slice of every series was the multi-series open bottleneck. But
`components/student/prefetch.ts` (`warmPrefetch`) early-returns on
`!manifest.hasImaging`, so it has been dead code, and `CasesPrefetcher` was
issuing one `/api/cases/{id}/prefetch` request per listed case for a payload
nothing read. This branch repointed `CasesPrefetcher` at the engine-chunk warm,
which is the part of opening a case that does not depend on the case.
`warmPrefetch` is still unreachable; either delete it or give the manifest the
one thing it would need (the opening SOP per series).

---

## Sources

- [Cornerstone3D — Progressive Loading](https://cornerstonejs.org/docs/concepts/progressive-loading/)
- [Cornerstone3D — Stack Progressive Loading](https://www.cornerstonejs.org/docs/concepts/progressive-loading/stackprogressive/)
- [Cornerstone3D — Volume Progressive Loading](https://www.cornerstonejs.org/docs/concepts/progressive-loading/volumeprogressive/)
- [Cornerstone3D — Retrieve Configuration](https://www.cornerstonejs.org/docs/concepts/progressive-loading/retrieve-configuration/)
- [Cornerstone3D — Progressive loading server requirements](https://www.cornerstonejs.org/docs/concepts/progressive-loading/requirements/)
- [OHIF v3.13 release notes](https://ohif.org/release-notes/3p13/)
- [OHIF v3.11 release notes](https://ohif.org/release-notes/3p11/)
- [dwv — DICOM Web Viewer](https://github.com/ivmartel/dwv)
- [Weasis — DICOM Viewer Features](https://weasis.org/en/features/)
- [OsiriX — Horos FAQ ("the Horos product has been withdrawn from distribution")](https://www.osirix-viewer.com/horos/faq/)
- [MicroDicom viewer](https://microdicom.com/)
- [MicroDicom — May 2026 release notes](https://www.microdicom.com/news/223-may-8-2026-new-version-dicom-viewer.html)
- [Orthanc Book — DICOMweb plugin](https://orthanc.uclouvain.be/book/plugins/dicomweb.html)
- [Cloud Healthcare API — DICOM conformance statement](https://docs.cloud.google.com/healthcare-api/docs/dicom)
- [DICOM WG-04 — HTJ2K Compression (Sup 235)](https://www.dicomstandard.org/news-dir/progress/docs/sups/sup235-slides.pdf)
