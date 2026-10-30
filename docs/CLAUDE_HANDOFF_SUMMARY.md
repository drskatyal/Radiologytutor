# Handoff — `claude/viewer-perf`

Date: 2026-10-30. Branched from `claude/epic-noether-3nvcbf` at `71c006a`
(PR #74). Five local commits, nothing pushed, nothing deployed.

```
26ecbfd  Benchmark the viewer against the field, and plan the desktop build
74ddf85  Open a DICOM study from the local disk, with nothing uploaded
1080baf  Give the stack a scrollbar, a keyboard and a cine transport
1cd4387  Start the viewer's unavoidable work before the viewer mounts
44e94f0  Tune the viewer engine for the device and warm slices ahead of the scroll
```

38 files, +5443 / −111. `npm run build` clean. `npm test` **628 pass, 0 fail**
(520 at `71c006a`; 9 new test files). `scripts/start-local.sh` left
uncommitted as instructed.

---

## 1. Where the work started

`npm run build` failed on a fresh checkout — `@phosphor-icons/react` was in
`package.json` but not installed. `npm install` fixed it; no code change was
needed. Worth knowing because it makes the first build anyone runs look broken.

Baseline after that: build clean, 520 tests passing.

---

## 2. (a) Resumed viewer work — what was open and what closed

`docs/UI_AUDIT.md`'s backlog was the live list. Three items closed:

- **#2 slice scrollbar** — the right edge of the stack now carries a track
  whose thumb height is the share of the series one slice represents, so a
  240-slice CT is visibly different from a radiograph. Draggable,
  `role="slider"`, slice in `aria-valuetext`. `lib/sliceScrollbar.ts` maps the
  pointer through the *thumb's travel*, not the raw track — otherwise the last
  slices are unreachable on a long series.
- **#3 tool shortcuts** — 1–5 pick the left-button tool, arrows and
  PageUp/PageDown move the stack (Shift jumps a twentieth), Home/End go to the
  ends, +/− zoom, `I` inverts, `0` resets, Shift+digit applies a window preset.
  Bound to the **viewport**, which is now focusable, because the student
  session already owns a set of global keys and a second `window` listener
  would fight it — a test asserts no viewport key collides with a session key.
  This also made the viewer keyboard-operable at all; it was a `role="img"`
  div that could not take focus.
  **Still open in #3:** a real menu widget. The toolbar's preset and
  measurement menus are still pointer menus with no arrow keys or typeahead.
- **#10 cine** — play/pause plus a frame rate, seeded from the series' own
  `CineRate` when it has one, hidden on a series too short to loop, stopping
  when the reader touches the stack. It advances the viewport *silently* so a
  teaching recording is not swamped with 15 slice events a second.

Backlog #1, #4, #5, #6, #7, #8, #9, #11 are untouched and still accurate.

### Did #74 and the MPR work actually work?

Verified in a real browser, not by inspection. `scripts/bench/smoke.mjs` drives
the running app over the DevTools Protocol:

| target | result |
|---|---|
| `/cornerstone` (bundled 10-frame sample) | **13/13** |
| `/case/<lidc>?mode=view` — real 65-slice CT via Orthanc + `/api/dicomweb` | **12/13** |
| `/viewer/local` (local file open) | **14/14** |

It asserts the canvas has lit pixels, the readout names a slice and a window,
the scrollbar reports the right ARIA values, the transport is present, the
viewport takes focus and answers arrows and digits, cine moves and pauses, and
MPR either builds three planes or explains why it cannot.

**The one failure, stated plainly:** MPR on the real volumetric CT. Headless
Chrome here renders through SwiftShader and Cornerstone logs `GPU not detected,
using CPU rendering`; the volume pipeline then has no WebGL context
(`no webgl context`, then a vtk.js `get3DContext` throw). The viewer caught it
and took its explained fallback — "This series couldn't be reconstructed. The
stack view stays on." So **MPR's failure path is verified on a real volumetric
series; MPR succeeding is not verified and needs a machine with a GPU.** That
is the single most important thing for the next person to check by hand.

---

## 3. (b) Performance — what changed and what it measured

All numbers from `scripts/bench/run.mjs`, best of 3, 8-core/15 GB Linux box.
Full tables, method and caveats in `docs/VIEWER_BENCHMARK.md`.

### 240-slice 512² CT, 40 ms per-request latency

| | first pixel | series ready | cold stack travel | QIDO bytes before first pixel |
|---|---|---|---|---|
| `71c006a` | 145 ms | 596 ms | 49.2 ms/slice | 21 KB |
| this branch | **83 ms** | **534 ms** | **10.7 ms/slice** | **0.2 KB** |

1200-slice CTA: 151 → 86 ms first pixel, 49.0 → 10.1 ms/slice, 105 KB → 0.1 KB.
240-slice 1024² at 10 ms RTT: 84 → 72 ms, 44.4 → 17.6 ms/slice.
`/viewer/local` first-load JS: 890 kB route / 1.08 MB → **8 kB / 193 kB**.

### The five changes, in order of how much they mattered

1. **Direction-of-travel prefetch** (`lib/prefetchPlan.ts`) — the big one,
   4.6×. The viewer had one prefetch rule: on a 200 ms scroll *pause*, warm a
   symmetric ±8 window. A reader who holds the wheel never produces that pause,
   so every slice was a cold round trip. Now, while the reader is moving, a
   handful of slices in the direction of travel are warmed on every slice
   change; the symmetric warm still runs on pause, with a radius that scales
   with series length (whole series ≤ 64 frames, else a window).
2. **Pre-warm before the viewer mounts** (`lib/viewerWarmup.ts`,
   `components/viewer/ViewerPrewarm.tsx`) — halves time to first pixel, and the
   harness *understates* it. The Cornerstone chunks are ~3.8 MB raw / ~1.0 MB
   gzipped and only started downloading when the viewer mounted; the opening
   frame's three round trips then started after that. Both now start on the
   case page immediately, and the frame warm works through the HTTP cache by
   issuing the *same URL with the same `Accept`* the Cornerstone loader will
   issue, so the viewer's own request is a hit.
3. **Known instance count → one 1-row QIDO** (`lib/progressiveStack.ts`) — a
   bytes win, not a milliseconds win at loopback latency. Without a count the
   loader paged the whole SOP list just to find a midpoint: 105 KB of JSON in
   front of the first pixel on a 1200-slice CTA.
4. **Device-aware engine knobs** (`lib/viewerRuntime.ts`) — decode workers,
   the decoded-pixel cache ceiling, the retrieval pool widths and
   `core.init({ isMobile })`. **Honest result: the worker bump 4 → 6 did not
   move these numbers**, because uncompressed little-endian decode is close to
   a memcpy; it is for the JPEG 2000 / JPEG-LS / HTJ2K syntaxes a real archive
   stores. The cache ceiling is a *memory-safety* change — Cornerstone defaults
   to **3 GB** of decoded pixels, which is a dead tab on a 4 GB laptop, and
   `isMobile` drops Cornerstone's WebGL context pool from 7 to 1 on phones.
5. **One session resolution per frame instead of two**
   (`app/api/dicomweb/[...path]/route.ts`) — the route called `getSession()`
   and then `activeOrgId()`, and `activeOrgId()` calls `getSession()` again. On
   a 500-slice scroll that was 1000 Better-Auth + domain-user reads. Now one,
   memoised against the exact `Cookie` header on a short TTL.
   `lib/ttlMemo.ts` is the bounded TTL memo the route had hand-rolled twice
   inline, now with tests; the share and ownership memos use it too.

### Two things to review rather than accept

- **`DICOMWEB_SESSION_TTL_MS` (default 10 s).** Caching a resolved session for
  pixel reads means a revoked session keeps reading for up to that long. It is
  consistent with the ownership and share memos already in that route (both
  60 s), and it is the only way that route survives a 500-frame scroll — but it
  is a deliberate, env-tunable security/performance trade and deserves a second
  opinion. Set it to `0` to disable.
- **`CasesPrefetcher` changed behaviour.** It used to issue one
  `/api/cases/{id}/prefetch` per listed case. That route's manifest is
  deliberately instance-free (`hasImaging: false`, empty `instances`) and
  nothing read the response, so those requests bought nothing. It now warms the
  engine chunks instead — the part of opening a case that does not depend on
  the case.

---

## 4. (c) Benchmark doc

`docs/VIEWER_BENCHMARK.md`. Three parts:

1. **The numbers**, with the harness to re-run them and an explicit "what this
   harness is not" (no Orthanc, no WAN, SwiftShader rendering, a local engine
   bundle). Each profile flips one knob so the table attributes the delta —
   which is how it is able to report the null result in §3.4 above.
2. **A feature matrix** against OHIF v3, the Cornerstone3D examples, dwv,
   Weasis 4, OsiriX MD, MicroDicom and 3D Slicer, plus a table of performance
   techniques and which of them we have.
3. **A prioritised gap list.** The P0s are reference lines / cross-series
   cursor, a DICOM tag browser, HTJ2K at ingest, and magnify.

**The biggest single latency lever left** is the progressive-retrieval
machinery Cornerstone3D already ships and we do not use. The library side is
installed (`loaders/ProgressiveRetrieveImages`,
`utilities/imageRetrieveMetadataProvider`, and `getPixelData` already honours
`retrieveOptions.streaming` / `rangeIndex`); the blocker is the server. Orthanc
supports only whole-object range queries on WADO-RS bulk data, so the
realistic path is **transcode to HTJ2K RPCL in the `orthancIngestInstance`
seam** — where we already rewrite every instance for de-identification — then
enable `streaming: true`. Cornerstone's own measurement on a 3036×3036,
11.1 MB image over 4G is **66 ms to first render** streaming, against nothing
on screen until the whole 11 MB lands.

---

## 5. (d) Desktop plan, and the first steps that were built

`docs/DESKTOP_PLAN.md` recommends **Tauri 2** over Electron: for a free utility
installed on a hospital workstation, a ~3–12 MB download against ~85–180 MB and
~40–60 MB idle RAM against ~170 MB *is* the product, and a full ~5 MB Tauri
update is smaller than an Electron diff. The market slot is open — Horos was
withdrawn from distribution in 2025 and HorosProject.org is closed; MicroDicom
is Windows-only and non-commercial-only; 3D Slicer is a research platform.

**The one thing that could reverse the recommendation, and must be spiked
first:** macOS WKWebView may lack `norm16` textures. Cornerstone's own
`core.init()` warns about exactly this on iOS, and a 16-bit CT rendered through
a path that silently loses low bits is a *clinical* defect. One day of work:
load `/viewer/local` with a 12-bit CT in WKWebView, check
`getSupportedTextureFormats().norm16`, compare a known ROI's HU against the
browser, and measure scroll frame rate. If it fails, `preferSizeOverAccuracy`
with the caveat surfaced in the UI, or Electron for macOS only.

The doc also covers local file/folder/DICOMDIR open, MSI + NSIS + DMG
artefacts, Apple notarisation **with stapling** (a hospital machine often has
no outbound internet, and an unstapled app fails there), Azure Artifact Signing
on Windows (~$10/mo, no EV certificates, installs under Smart App Control
without a block), the Tauri updater's Ed25519 signing and full-binary
limitation, CI, risks, and a ~$220/yr cost line.

### What was actually implemented — Stage 0, finished

`/viewer/local` opens a study folder **in the browser today**, with no server
involvement at all. It is the surface the desktop shell will wrap, not a
prototype of it.

- `lib/localStudy.ts` — **no imports at all**, pure arithmetic, so it ports to
  the desktop unchanged. DICM magic at offset 128 *and* 0 (anonymisers write
  preamble-less files), DICOMDIR and junk recognition, study/series grouping,
  and the ordering rules: along the slice normal first because that is the only
  anatomically correct order, then InstanceNumber, then natural file-name order
  so `IM9` precedes `IM10`. A degenerate position set falls through rather than
  scrambling; files whose identity is unreadable group by folder rather than
  being dropped.
- `lib/localDicomFiles.ts` — the only module that knows about `File`. Reads
  the first 256 KB per file, stops the parse at PixelData, hands the `File` to
  Cornerstone's wadouri file manager so pixels stream off disk on demand (a
  2 GB CTA is never held in memory to list it), reports progress, cancels. The
  parser is injected, so the tag extraction is unit-tested in Node.
- `ViewerSource` gained an `imageIds` kind. `/viewer/local` renders it with the
  full toolbar, the slice scrollbar, the keyboard, cine, measurements and MPR.
- A dropped *folder* arrives as one entry with no `File`, so the drop handler
  walks `webkitGetAsEntry` directories and preserves the relative path.

**Known limitation, stated rather than hidden:** DICOMDIR is detected and
*skipped*, because we read every file in the selection anyway and the image
headers are the authority on grouping. Correct for a folder drop, wrong for
media where the index is the only way to find the images.

**Deliberately not started:** the `desktop/` directory, Tauri config, any
signing credential, any release job — all of it is downstream of the WKWebView
spike, and a rendering-accuracy failure there would throw the packaging work
away.

---

## 6. New tooling

```bash
# Synthetic WADO-RS origin + headless Chrome driving the shipped loader.
node scripts/bench/run.mjs --slices 240 --latency 40 --metadata-build 400 --scroll 40 --repeats 3

# The real viewer UI in a real browser, against a running app.
npx next start -p 3123
node scripts/bench/smoke.mjs http://127.0.0.1:3123/cornerstone
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs http://127.0.0.1:3123/viewer/local
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs \
  'http://127.0.0.1:3123/case/<caseId>?mode=view'
```

- `scripts/bench/mockDicomweb.mjs` — serves a synthetic uncompressed 16-bit
  series shaped the way Orthanc shapes one, including the same `Cache-Control`
  headers `lib/dicomwebProxy.ts` stamps, so the browser cache behaves as it
  does in production. No dependencies.
- `scripts/bench/harness.ts` — drives the real `lib/progressiveStack.ts` and a
  real Cornerstone stack viewport. **Asserts the opening frame actually
  decoded** (rows, columns, pixel count); without that, an image with missing
  metadata still fires `IMAGE_RENDERED` on a blank canvas and every number
  would be measuring an empty viewport.
- `scripts/bench/smoke.mjs` — CDP over Node's built-in `WebSocket`, no
  puppeteer. Captures page console, exceptions and ≥400 responses, and can sign
  in through `/api/auth/demo` (`SMOKE_DEMO_ROLE`) so it can exercise pages that
  read pixels through `/api/dicomweb`.

Artefacts (`scripts/bench/.build/`, `scripts/bench/results/`) are gitignored.

---

## 7. Open items, in the order I would take them

1. **Verify MPR on a GPU machine.** The only thing this branch touched that
   could not be verified end to end. Everything needed is in place:
   `node scripts/bench/smoke.mjs` against a volumetric case on a box with real
   WebGL should turn the one failing check green.
2. **Run the WKWebView spike** (`docs/DESKTOP_PLAN.md` §1.1) before any
   packaging work.
3. **Review `DICOMWEB_SESSION_TTL_MS`** (§3 above). It is the one change on
   this branch with a security dimension.
4. **P0s from `docs/VIEWER_BENCHMARK.md` §4** — reference lines / cross-series
   cursor (needs an active-viewport notion, which `docs/UI_AUDIT.md` backlog #7
   also wants), DICOM tag browser, HTJ2K at ingest, magnify.
5. **Resolve `components/student/prefetch.ts`.** `warmPrefetch` is unreachable:
   it early-returns on `!manifest.hasImaging`, and `buildPrefetchManifest`
   always returns `false` by design. Either delete it and
   `selectWarmTargets` / `wadoFrameUrl`, or give the manifest the one field it
   would need (the opening SOP per series). Not touched here because deleting
   another branch's module was outside this brief.
6. **A real menu widget** for the toolbar's preset and measurement menus — the
   remaining half of `docs/UI_AUDIT.md` backlog #3.

### One unresolved curiosity, recorded so it is not rediscovered

Pointing `/cornerstone?study=…&series=…&root=<my synthetic mock>` at the app
fails to decode the opening frame with
`Cannot read properties of undefined (reading 'samplesPerPixel')` — i.e.
`metaData.get('imagePixelModule', imageId)` returns undefined even though
`lib/progressiveStack.ts` registered that exact imageId. I spent real time on
it and did **not** isolate it. What is known:

- The **pre-change commit `71c006a` fails identically**, so it is not a
  regression from this branch.
- The **same code, same data, same server decodes correctly** when bundled by
  esbuild (the benchmark harness proves it: 512×512, 262144 pixels).
- The **product's own path is fine** — a real 65-slice CT through
  `/api/dicomweb` renders (12/13 smoke).

So it is specific to the ad-hoc `?root=` query on `/cornerstone`, which is not
a configuration the product uses, and it is most likely a quirk of my synthetic
series or of that page's two-phase source switch rather than a product defect.
Flagged rather than chased further.

---

## 8. Things deliberately not done

- No push, no deploy, no change to `claude/epic-noether-3nvcbf`.
- No change to tool bindings, scroll-sensitivity maths, window/level, zoom,
  pan, measurement drawing, record/replay, the tutor, or auth beyond the one
  session-resolution fix on the DICOMweb route.
- No secrets in any commit (checked: the two apparent hits in a value scan were
  the project-name string in `flowrad.bundled.study` and `flowrad_demo`, not
  credentials).
- `scripts/start-local.sh` left untracked.
