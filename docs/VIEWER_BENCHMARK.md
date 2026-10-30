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
