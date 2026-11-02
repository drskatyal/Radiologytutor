# FlowRad Viewer — the free web viewer (`/viewer`)

Public, no sign-in, no paywall. Drop a folder, a ZIP, a CD (DICOMDIR) or loose
DICOM files and read the study in the browser. **Your images never leave your
computer**: nothing is uploaded, stored, or analysed. A soft, dismissible prompt
offers a free account only for what needs one — save, share, teach, the AI
tutor, priors.

`/viewer/local` is the same component inside the RadLearn app shell.

## Pipeline

```
drop / pick (folder · ZIP · CD · files)
  │  ZIP: central directory only; STORED entries are zero-copy Blob slices,
  │       DEFLATED entries inflate via native DecompressionStream
  │       (packages/viewer-core/src/zipArchive.ts)
  │  natural sort; skip DICOMDIR + obvious junk without reading
  ▼
main-thread lane: the natural-order middle file → FIRST IMAGE painted
worker lanes:     every other header, in a pool of Web Workers
                  (localHeaderWorker.ts; 64 KB read, 256 KB only if needed)
  ▼
group + order (localStudy.ts) → full stack swapped in place, no remount
  ▼
Cornerstone decode workers read pixels off disk on demand; WASM codecs
(OpenJPEG, CharLS, libjpeg-turbo, OpenJPH) load only for the transfer syntax
in use; decoded cache capped per device (viewerRuntime.ts) and LRU-evicted;
"Close study" purges the cache and every File handle.
```

While the dropzone is showing, an idle callback warms everything the first drop
needs: the header parser and worker pool, the viewer chunk, the Cornerstone
engine with its decode workers, and the first WebGL context.

## Privacy contract

- No request after a drop except same-origin `GET`s of `/_next/static/` chunks.
- Nothing from a DICOM header is logged: timing logs carry numbers only
  (`lib/viewerTiming.ts`), and every viewer error log goes through
  `safeErrorText` (`packages/viewer-core/src/safeLog.ts`), which never prints a
  loader's `dataSet` and masks UIDs.
- No analytics on this surface. The session-cookie notice is not shown: viewing
  sets no cookie.

## Gates (CI, `.github/workflows/web-ci.yml`)

| Gate | Where |
| --- | --- |
| Shell JS ≤ 300 KB gzipped | `scripts/perf/viewer-bundle-budget.mjs` |
| First image ≤ 1 s (CT 520 folder; 5-series J2K MR ZIP) | `e2e/visual/free-viewer.perf.spec.ts` |
| No main-thread task > 50 ms while scrolling 240 slices | same |
| Scroll p95 frame ≤ 20 ms on a GPU, ≤ 34 ms on SwiftShader (CI) | same |
| Decoded cache ≤ cap on an emulated 2 GB device; 0 after Close | same |
| No WASM for uncompressed CT; OpenJPEG only for J2K | same |
| No data leaves the page; no identifier in a URL or the console | same |

Fixtures are synthetic and deterministic: `scripts/make-test-ct.py --slices 520`
and `scripts/make-test-mr.py`. `scripts/perf/viewer-perf-table.mjs` renders the
results table into the job summary.

CI runners have no GPU. The perf spec launches Chromium with a GPU-rasterised 2D
canvas (the default on any desktop Chrome with a GPU) so the WebGL → canvas copy
is not charged to the main thread as a software readback; frame pacing there is
still bound by SwiftShader at ~30 fps, hence the separate software-GPU budget.
