# Converted DICOM delivery: HTJ2K + previews via Cloud CDN

Date: 2026-10-31. Branch `claude/dicom-cdn`, cut from `claude/epic-noether-3nvcbf` @ `7fc7c45` (prod).
GCP project `radlearn-app`, region `europe-west2`. **Not deployed, not merged.** The feature is off until the env vars below are set.

## TL;DR

- **Convert once.** After an upload settles, the app re-reads the series from the archive and writes a *bundle* to a **private** bucket: lossless HTJ2K frames (RPCL progression, so a prefix of a frame decodes to a lower resolution), small 8-bit JPEG previews at the default window, and one gzip metadata document. A backfill script converts the studies that already exist.
- **Batch.** A bundle is ~8 frames (≤1 MB) per full-quality chunk and 32 previews per preview chunk. A 1000-slice CT is about 200 requests, not 1000+. The open slice is also fetched on its own with an HTTP `Range` request, so its full-quality frame doesn't wait for its 7 neighbours.
- **Preview first.** The viewer paints the 8-bit preview straight away, then swaps the 16-bit frame in place (same camera, same window). While a preview is on screen a small **Preview** chip shows, and window/level, window presets and measurement tools are blocked. Scroll, pan, zoom, invert and reset stay live.
- **Load order.** The current slice goes first, then its neighbours outward. Previews for the whole stack come early (they are about 1/20 of the bytes), then the rest. The order is re-planned every time the reader moves.
- **On device.** Chunks go into the Cache API, so reopening a case is mostly local. It is cleared on sign-out.
- **Fallback.** If any step fails (no bundle yet, a multi-frame series, a fetch or decode error, an old browser), that slice is loaded over DICOMweb exactly as today. The imageIds never change.
- **Privacy.** The bucket has public access prevention enforced and no `allUsers` binding. Pixels are reachable only through a **Cloud CDN signed URL prefix**, minted for one series version after the same session + org check as `/api/dicomweb`, or through the authenticated same-origin proxy. De-identification is unchanged: the converter only reads what is already in the archive.

## What changed

| Piece | File(s) |
|---|---|
| Bundle format, ordering plan, open-index rule | `lib/dicomCdn/format.ts` |
| 8-bit preview windowing + exact inverse into stored pixel values | `lib/dicomCdn/windowing.ts` |
| HTJ2K (OpenJPH) + JPEG (libjpeg-turbo) encoders, the WASM codecs Cornerstone already ships; no new dependency | `lib/dicomCdn/encode.ts` |
| Series packer: archive → bundle, index written last, old versions swept | `lib/dicomCdn/pack.ts` |
| Private store: GCS JSON API with the Cloud Run service account (no HMAC secret), or a local dir for dev | `lib/dicomCdn/store.ts` |
| Env config; refuses a CDN without a signing key | `lib/dicomCdn/config.ts` |
| Cloud CDN signed URL prefix (HMAC-SHA1) | `lib/dicomCdn/sign.ts` |
| In-process jobs: debounced after upload, lazily on first view, one per series | `lib/dicomCdn/jobs.ts`, hook in `lib/uploadIngest.ts` |
| `GET /api/dicom-cdn/manifest`: index + signed prefix (or proxy base) | `app/api/dicom-cdn/manifest/route.ts`, `lib/dicomCdn/manifest.ts` |
| `GET /api/dicom-cdn/files/...`: authenticated proxy when no CDN, honours `Range` | `app/api/dicom-cdn/files/[...path]/route.ts` |
| Shared study gate (moved, unchanged), used by `/api/dicomweb` and the new routes | `lib/studyAccess.ts` |
| Client: manifest cache, chunk scheduler, range fetch, memory budget, warm stash | `lib/dicomCdn/client.ts` |
| Device cache (Cache API, per-series, LRU budget, cleared on sign-out) | `lib/dicomCdn/deviceCache.ts`, `components/auth/AuthButtons.tsx` |
| Cornerstone bridge: wraps the `wadors` loader, preview → full swap, DICOMweb fallback, HTJ2K decoder warm | `lib/dicomCdn/cornerstoneBridge.ts` |
| Stack open via bundle (same imageIds), case-page warm | `lib/progressiveStack.ts`, `lib/viewerWarmup.ts` |
| Preview chip, W/L / preset / measurement lock, timing marks | `components/CornerstoneViewer.tsx`, `lib/dicomCdn/previewLock.ts`, `lib/viewerTiming.ts` |
| Backfill (previews included) | `scripts/dicom-cdn-backfill.ts` (`npm run dicom-cdn:backfill`) |
| Infra: bucket, backend bucket + CDN, signed-URL key, HTTPS LB, IAM | `deploy/gcp/terraform/dicom_cdn.tf`, `variables.tf`, `run.tf`, `deploy-app.sh`, `env.example` |
| Bench: `bundle` profile, real packer, shared-bandwidth link model, `Range`, Part-10 instances | `scripts/bench/*` |

### Bundle layout (private bucket)

```
dicom/v1/{StudyUID}/{SeriesUID}/index.json           server-read only (Cache-Control: private, no-store)
dicom/v1/{StudyUID}/{SeriesUID}/{version}/meta.gz    whole-series DICOM JSON, no bulk data
dicom/v1/{StudyUID}/{SeriesUID}/{version}/p0000.frb  32 × JPEG preview + their metadata (gzip header)
dicom/v1/{StudyUID}/{SeriesUID}/{version}/f0000.frb  ≤8 × HTJ2K lossless frames, ≤1 MB
```

- `.frb` is `"FRB1" | u32 header length | gzip(JSON header) | payload`.
- The index lists each full frame's byte range in its file, which is what makes the single-slice `Range` fetch possible.
- Version directories are immutable (`Cache-Control: private, max-age=31536000, immutable`). `index.json` is written **last**, so a reader only ever sees a complete version.
- Stack order is the archive's series-metadata order, the same order the DICOMweb path uses, so stored `sliceIndex` values still land on the same image.

**Lossless fallback.** If HTJ2K encoding throws, the raw Explicit VR LE frame is stored instead, never a lossy substitute. If the archive will only return a compressed frame, those exact bytes are stored with their own transfer syntax (no preview). Colour frames take the same route.

**Stays on DICOMweb.** Multi-frame instances: the viewer addresses `/frames/1`, so packing one would drop frames.

### How the preview is made safe to swap

A preview is decoded from JPEG and mapped back through the window it was rendered at into **stored pixel values**, at the frame's own bit depth and signedness. It is then handed to Cornerstone's own `createImage` as an uncompressed frame with the real metadata. So it goes through exactly the same rescale / VOI / MONOCHROME1 / spacing pipeline as the real frame. Under the default window it looks the same, just quantised, and the swap is a sharpening rather than a flash.

Outside that window the preview has no information. That is why window/level, presets and measurement are blocked until the full frame lands. Teach-mode windows still apply programmatically.

MPR (volume) requests never receive previews.

## Privacy and access

- **Bucket.** Uniform access, `public_access_prevention = "enforced"`. The app service account has `storage.objectAdmin` on **that bucket only**. The Cloud CDN fill agent has `objectViewer` on it.
- **Gate.** Before anything is signed: `lib/studyAccess.ts`, the same code `/api/dicomweb` uses (moved, not changed). That means a Better Auth session whose active org owns the StudyInstanceUID, or a case-share cookie naming it. Client-supplied `orgId` is never trusted. Anonymous → 401, another org's study → 404.
- **Signature scope.** One series version directory (`…/{study}/{series}/{version}/`), default 1 h (`DICOM_CDN_URL_TTL_SECONDS`, clamped 60 s – 12 h). The client re-asks before expiry or on a 401/403.
- **CDN caching.** Cloud CDN checks the signature on every request, cache hit or miss. Objects say `private`, so no other shared cache may keep them; the backend bucket uses `FORCE_CACHE_ALL`, so the edge still does. Chunk fetches send no cookies.
- **Config guard.** `DICOM_CDN_URL` without `DICOM_CDN_KEY_NAME` + `DICOM_CDN_KEY` throws, and the feature turns itself off. There is no way to configure an unsigned CDN.
- **De-identification.** Unchanged. Uploads still pass `lib/teachingDeidentify.ts` and the `lib/deid.ts` gate before STOW. The converter reads back from the archive, so it only ever sees what the gate already passed. Pixel OCR is still not claimed. Previews carry whatever the pixels carry, same as today.
- **Device cache.** Holds the same de-identified pixels the viewer already shows. It is per series, has a budget (2 GB desktop, 400 MB phone or ≤4 GB RAM) with LRU eviction, and is cleared by **Sign out**. It is *not* cleared when a session simply expires (follow-up below).
- **Signing key.** Lives in Secret Manager (`DICOM_CDN_KEY`). Terraform also needs it for the backend-bucket key, so it lands in Terraform state: keep state private.

## Measured

### Synthetic bench (re-runnable, numbers below are from this branch)

```bash
node scripts/bench/run.mjs --slices 240  --latency 40 --metadata-build 400 --bandwidth 50 --repeats 3 --profiles tuned,bundle
node scripts/bench/run.mjs --slices 1000 --latency 40 --metadata-build 400 --bandwidth 50 --repeats 3 --profiles tuned,bundle
```

**Setup.** Headless Chrome drives the shipped loader and a real Cornerstone stack viewport against a mock origin:
- 40 ms per request, a shared 50 Mbit/s downstream link, and a 400 ms series-metadata build (what Orthanc-like archives do).
- `tuned` is today's DICOMweb path with all current optimisations.
- `bundle` is this branch, with the bundle produced by the **real packer**, served same-origin at the same latency. There is no CDN edge here.
- Best of 3. Open timings varied by about ±30 ms between runs.

**240 slices (512², 16-bit)**

| | first paint | full quality on screen | stack scrollable | cold scroll | bytes moved in the run |
|---|---|---|---|---|---|
| DICOMweb (`tuned`) | 216 ms | 216 ms | 728 ms | 86 ms/slice | 25.5 MB |
| bundle | **175 ms** (preview) | **202 ms** | **210 ms** | **10.9 ms/slice** | **15.4 MB** |

**1000 slices (512², 16-bit)**

| | first paint | full quality on screen | stack scrollable | cold scroll | bytes moved in the run |
|---|---|---|---|---|---|
| DICOMweb (`tuned`) | 222 ms | 222 ms | 924 ms | 86 ms/slice | 23.5 MB |
| bundle | **208 ms** (preview) | **221 ms** | **338 ms** | **9.1 ms/slice** | **14.4 MB** |

Converting 1000 synthetic frames took 23.5 s on one process: 524 MB raw → 166 MB HTJ2K, previews 0.9 MB.

What these numbers do **not** cover:
- The synthetic frames are noise plus gradient. Real CT compresses differently, and its JPEG previews are bigger (typically 8–15 KB at 384 px, against ~1 KB here).
- There is no real CDN edge and no TLS.
- Rendering is SwiftShader.

The robust wins are the ones the network structure explains: no series-metadata build in front of the stack (scrollable 3× sooner), ~9× faster cold scroll (a chunk carries 8 slices and is prioritised around the reader), and fewer bytes.

On a link with no bandwidth cap (localhost), DICOMweb's raw frames are free to move, and first paint is a wash or slightly slower for the bundle. The extra cost there is the manifest round trip and the first HTJ2K decode compiling OpenJPH's WASM in a worker. Two changes keep that out of the first paint: the opening slice always paints its preview while the decoder is cold, and the decoder is warmed in the other workers right after.

The benches also ruled out some alternatives:
- Warming the decoder at engine start added ~40 ms to first preview.
- 2 MB full chunks, and no `Range` fetch for the open slice, cost ~90 ms of full-quality time.

### End-to-end in the real app (this environment)

**Setup.** A production build (`npm run build`, clean) with:
- the JSON data layer, holding a copy of the seed in which `case-lidc-nodule-search` points at the mock archive's 160-slice series;
- `DICOMWEB_BACKEND=healthcare`, with the root aimed at the mock;
- `DICOM_CDN_LOCAL_DIR`, so chunks are served through the authenticated proxy.

**What was checked (server side, then viewer).**
- Manifest: 401 anonymous; 404 for a study the org doesn't own; `converting` on first view. The conversion then ran in-process: 160 frames, 84 MB → 26.6 MB, 4.4–5.6 s.
- Chunks: proxied with a 200; a `Range` request returned 206 with exactly one frame; anonymous chunk 401; path traversal 404.
- `scripts/bench/smoke.mjs` against `/case/case-lidc-nodule-search?mode=view`:
  - Bundle view: `first preview` → `first pixel` → `full quality` marks in order.
  - The mock's DICOMweb frame counter did **not** move: every pixel came from the bundle.
  - MPR built all three planes from bundle frames, with no page errors.
  - 12/13 checks passed. The one failure, "rendered frame has non-black pixels", also fails on the DICOMweb path here: this headless Chrome cannot read a WebGL canvas back.

**Seen during these runs.**
- One DICOMweb view, taken *while the in-process conversion was running*, logged a `samplesPerPixel of undefined` exception. It did not reproduce in three later DICOMweb runs.
- Those three runs flaked one 401 on their own, with the feature switched off (`?dicomcdn=off`), so that 401 is not from this branch.
- The exception is listed as an open item.

## How to measure first-preview and full-quality time

Applies to `case-lidc-nodule-search` and the ~1000-image study.

**Marks.** The viewer writes User Timing measures (`lib/viewerTiming.ts`) on every open:

| measure | meaning |
|---|---|
| `radlearn:navigation-to-first-preview` | 8-bit preview on screen (bundle path only) |
| `radlearn:navigation-to-first-pixel` | first frame of any quality |
| `radlearn:navigation-to-full-quality` | the frame on screen is the real 16-bit one (W/L + measurement unlocked) |
| `radlearn:navigation-to-series-ready` | whole stack scrollable |

The console also logs `[radlearn] viewer first preview / full quality {ms, source}`.

**1. Convert both studies**

Run this from a laptop against prod (read-only on the archive; writes only to the private bucket):

```bash
export DICOMWEB_BACKEND=healthcare HEALTHCARE_PROJECT=radlearn-app HEALTHCARE_LOCATION=europe-west2 \
       HEALTHCARE_DATASET=radlearn HEALTHCARE_DICOM_STORE=radlearn-dicom \
       DICOM_CDN_BUCKET=radlearn-app-dicom-cdn MONGODB_URI='…' MONGODB_DB=radlearn
export GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)
```

```bash
npm run dicom-cdn:backfill -- --case case-lidc-nodule-search
```

```bash
npm run dicom-cdn:backfill -- --study <StudyInstanceUID of the ~1000-image study>
```

Use `--dry-run` first if you like. The script prints frames, source MB, HTJ2K MB, preview MB and seconds per series. Use `--all` for every case.

**2. Measure in a browser** (Chrome DevTools)

1. Open the case. Get a cold start: Application → Storage → *Clear site data*. This clears the device cache too. Network → *Disable cache* and a throttle profile (e.g. *Fast 4G*) make the numbers comparable.
2. Bundle path: load `/case/<id>?mode=view&dicomcdn=on`. Performance panel → Timings, or run:
   ```js
   performance.getEntriesByType("measure").filter(m => m.name.startsWith("radlearn:")).map(m => [m.name, Math.round(m.duration)])
   ```
3. DICOMweb path, same browser: `?dicomcdn=off` (sticky in `localStorage` until `?dicomcdn=on`). Repeat step 2.
4. Warm device: reload without clearing site data. Chunks now come from the Cache API.
5. Run each case 3–5 times and report medians. Open timings vary ±30 ms even in the synthetic bench.

**3. Scripted** (same marks, headless Chrome)

```bash
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs 'https://<app>/case/case-lidc-nodule-search?mode=view&dicomcdn=on'
```

```bash
SMOKE_DEMO_ROLE=super_admin node scripts/bench/smoke.mjs 'https://<app>/case/case-lidc-nodule-search?mode=view&dicomcdn=off'
```

Each prints a `TIMING {...}` line. Headless Chrome uses a fresh profile, so every run is cold.

**What to record.**
- For both studies and both paths: first preview, full quality, series ready, plus a 30-slice scroll after open.
- Bytes from the DevTools Network summary.
- In Cloud CDN logs, `jsonPayload.cacheHit` shows whether the edge served it.

## Cost note

These are list-price **estimates** for `europe-west2` / Europe egress, rounded and checked against memory, not a quote. Re-check in the GCP pricing calculator before relying on them.

**Example study.** A 1000-slice 512² CT: about 525 MB uncompressed. Lossless HTJ2K on real CT is typically 40–50 % → **~240 MB**, plus ~12 MB of previews and well under 1 MB of metadata.

| | today (DICOMweb via Cloud Run) | bundle via Cloud CDN |
|---|---|---|
| Storage | Healthcare DICOM store (unchanged, still the source of truth) | **+** ~0.25 GB in GCS Standard ≈ $0.006 / study / month |
| One-off conversion | — | ~25 s CPU on a 2 vCPU Cloud Run instance that is already always-on ≈ $0.001 / series; plus one full DICOMweb read of the series |
| Bytes per full-series view | as stored: up to ~525 MB if stored uncompressed | ~250 MB |
| Egress per 1,000 full-series views | ~525 GB Cloud Run internet egress at ~$0.12/GB ≈ **$60** | ~250 GB Cloud CDN egress at ~$0.08/GB ≈ **$20**; cache fill is once per edge |
| Requests per view | ~1000+ WADO-RS frame reads, each through Cloud Run → Healthcare API (billed as DICOMweb operations, plus Cloud Run CPU time) | ~200 CDN lookups (≈ $0.0075 / 10k) and no Healthcare API read on a cache hit |
| Fixed | — | global LB forwarding rule ≈ $18 / month; managed cert free |

**Net.** At a few hundred full views a month the fixed load-balancer charge dominates and the saving is small. Past roughly a thousand views a month, CDN egress at ~⅓–½ of the bytes, with no per-frame Healthcare/Cloud Run work, comes out clearly cheaper and takes read load off the DICOM store quota (no 429s in a class).

**Repeat opens on the same device** cost close to nothing (Cache API).

**Scrolling only.** A learner who only scrolls still pulls full frames in the background. A future switch could stop full-frame prefetch beyond a radius on metered connections, which would cut that further.

## Turning it on (operator steps, not done here)

1. Terraform, with `dicom_cdn_bucket = "radlearn-app-dicom-cdn"`, and once DNS is ready also `dicom_cdn_domain` and `dicom_cdn_signing_key`. Generate the key with:
   ```bash
   head -c 16 /dev/urandom | base64 | tr +/ -_
   ```
   Point an A record at `terraform output dicom_cdn_ip`. The bucket's CORS origin is `public_url`.
2. Add the same key as a version of the `DICOM_CDN_KEY` secret.
3. Set `DICOM_CDN_BUCKET`, `DICOM_CDN_URL=https://<domain>` and `DICOM_CDN_KEY_NAME` in `deploy/gcp/env.local`, then run `deploy-app.sh`. It attaches `DICOM_CDN_KEY` when a version exists.
   - Bucket only, no URL: chunks are served by the app through `/api/dicom-cdn/files`. That path is still batched HTJ2K, just without the edge.
4. Run the backfill (above).

**New uploads** convert about 45 s after their last batch (`DICOM_CDN_UPLOAD_SETTLE_MS`). **Unconverted series** convert on first view in the background; that view itself uses DICOMweb.

**Kill switch.** `DICOM_CDN_DISABLED=1`: the manifest then says unavailable and every viewer reads DICOMweb. `DICOM_CDN_BUILD=off` stops in-app conversion and leaves conversion to the backfill.

**Logs.** `[dicom-cdn] converted {…}`, `stays on DICOMweb`, `conversion failed`; in the browser, `[radlearn] bundle frame failed, using DICOMweb`.

## Limits and follow-ups

- **Conversion runs inside the web service.** It is capped at 2 at a time per instance. The WASM encode is CPU work that competes with requests on that instance. For large backfills, run the script as a Cloud Run **Job** with the app image rather than relying on first-view conversion.
- **Progressive HTJ2K is stored but not yet streamed.** The client fetches whole frames. Cornerstone's HTJ2K byte-range streaming could later show a sub-resolution full-quality frame before the preview → full swap.
- **Not converted, by design:** multi-frame series. Colour images get no preview; their frames are stored as-is (lossless), with no HTJ2K.
- **Device cache on session expiry.** It is cleared on explicit sign-out only. Clearing on session expiry needs a hook in the auth seam.
- **Open item:** the single `samplesPerPixel` exception seen on a DICOMweb view during a concurrent conversion, described in "End-to-end" above.
- **Not measured from here:** a real CDN edge, TLS, and real-world numbers on the LIDC and ~1000-image studies. Those are the steps in "How to measure".
