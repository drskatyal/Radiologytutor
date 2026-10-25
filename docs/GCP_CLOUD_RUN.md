# Cloud Run + Healthcare DICOM store

**Deferred.** Human-teacher fidelity comes first; DICOM latency is secondary. Do not deploy this path until Teach-mode fidelity is proven on a real case. PR #15 stays draft. Fly and local Orthanc remain the live imaging path.

Production imaging for FlowRad Learn. The Next.js app runs on **Cloud Run**. Study bytes live in a **Cloud Healthcare API DICOM store** in the same region. The browser still talks only to `/api/dicomweb`. Local Orthanc and the Fly apps stay until the checklist at the bottom is done.

This is the fastest way to open a study **on Cloud Run**. A warm Orthanc process with a local SSD can beat a regional API for one reader. Cloud Run has no local disk, so that shape is not available here. Putting Orthanc on Cloud Run makes it worse: the app would call a second Cloud Run service, which would call Cloud SQL and then GCS. The Healthcare store is that storage without the extra process.

We have not run Google's `healthcare-imaging-performance-test` in this repo. The FPS figures below are from [DICOM best practices](https://docs.cloud.google.com/healthcare-api/docs/how-tos/dicom-best-practices) (page updated 2026-05-20), for 0.5 MB frames, same region, no compression. Treat them as Google's number, not ours.

## Request path — student opens a case

```
browser  →  Cloud Run (Next.js, min instances ≥ 1)
              ├─ Better Auth session
              ├─ org owns this StudyInstanceUID
              └─ GET https://healthcare.googleapis.com/v1/projects/PROJECT/locations/REGION/datasets/DATASET/dicomStores/STORE/dicomWeb/...
                   Authorization: Bearer <runtime service account>
```

1. The learner opens `/case/[caseId]`. Cloud Run is already up (`min-instances` ≥ 1, CPU always allocated), so this request does not pay a container boot.
2. The server builds the prefetch manifest. Series and instance lists are QIDO-RS against the DICOM store (`lib/orthanc.ts` → `lib/healthcareDicom.ts`). That is metadata, not pixels.
3. Cornerstone loads series metadata, then frames, all as same-origin `GET /api/dicomweb/studies/{study}/series/{series}/...`. The route is `app/api/dicomweb/[...path]/route.ts`.
4. The route checks the session, then that the caller's org holds that StudyInstanceUID (unchanged). It does not accept a client-supplied `orgId`.
5. Frame reads may check the private object cache for at most `FRAME_CACHE_WAIT_MS` (default 25). A slow or empty cache does not sit in front of the first slice. On a miss the route calls the DICOM store and streams the body back.
6. Upstream Accept on frames is the stored transfer syntax (`transfer-syntax=*`) unless the client already named one. That skips Healthcare's transcode. Rendered series thumbnails are requested as `image/jpeg`, which an `<img>` can paint. See `upstreamAccept` in `lib/imagingBackend.ts`.
7. Frame responses are `Cache-Control: private, immutable` plus `Vary: Accept`. The browser may reuse them. A shared cache must not.
8. Cornerstone decodes in up to 4 web workers. The retrieval pool allows 16 interaction requests (the library default is 6). Prefetch (`components/student/prefetch.ts`) asks for the first 32 frames of the opening series with the same Accept, so a repeat fetch can be a browser or object-cache hit.
9. Voice is a different path and does not touch the DICOM store. `/api/transcribe` and `/api/tutor` call Gemini with `GEMINI_API_KEY`. `/api/tts` uses ElevenLabs when the teacher has a clone, otherwise Gemini TTS. If that exceeds `VOICE_LATENCY_BUDGET_MS`, `/api/voice/realtime` mints a short-lived token and the browser opens Gemini Live itself. The key never goes to the client.

Upload (author), still one gate:

1. `POST /api/upload` → `orthancIngestInstance`.
2. `lib/deid.ts` inspects headers and refuses residual identity tags. Pixel OCR is still not claimed.
3. On Healthcare, the bytes are STOW-RS: `POST {dicomWebRoot}/studies` with `Content-Type: application/dicom`.
4. The passing `DeidReport` is stored in Mongo under the StudyInstanceUID. Publishing still requires that report.

Google's dataset de-identify job is a separate copy of a store. It is not the publish gate and it does not replace `lib/deid.ts`.

## Why this beats Orthanc on Cloud Run

| | Healthcare DICOM store | Orthanc on Cloud Run | Orthanc VM + local SSD |
|---|---|---|---|
| First slice | One regional DICOMweb read from a warm Next.js process. The store does not cold-start. `transfer-syntax=*` returns the file as stored. | App → second Cloud Run service → Cloud SQL index → GCS object. Orthanc boot is seconds if `min-instances` is 0. Warm, it is still an extra service. | Fastest single-reader disk read. Not a Cloud Run service, and one machine queues a class. |
| Scroll | HTTP/2 to one origin. Pool of 16. Google's guide: same region, 0.5 MB frames, about 30 FPS at 6 in flight and about 60 FPS at 20. Prefetch the opening 32 slices. | Same browser work, plus Orthanc's concurrency cap and the SQL/GCS hop on every miss. | Excellent until the disk or the one process saturates. |
| Ops | One Cloud Run service, one dataset, one DICOM store, one service account. | Two services, Cloud SQL, the GCS plugin, a VPC path to private SQL. SQLite on a bucket will corrupt. | Patch the VM, the disk, and failover yourself. |
| Cost shape | DICOM storage and DICOMweb operations, plus one always-on Cloud Run instance (the price of no cold start). No Cloud SQL. | That, plus Cloud SQL always-on and a second minimum instance. | One VM always on. |
| Upload / de-id | Header gate, then STOW-RS. Ids returned to the app are DICOM UIDs. | Header gate, then Orthanc `POST /instances`. Ids are Orthanc hashes. | Same as Orthanc. |

Orthanc on Cloud Run is not in the deploy scripts. Shipping it would invite a slower production path. `docker-compose.orthanc.yml` and `fly.orthanc.toml` are the Orthanc paths that still exist.

## Auth

The browser does not hold a Google token for the DICOM store, and it does not receive a signed DICOM URL. The Healthcare API has no presigned WADO-RS URL. IAP in front of the app would be a second login and would not authorize the store.

- **Learners and teachers:** Better Auth session on `/api/dicomweb` and `/api/upload`, then the org-ownership check.
- **Cloud Run → DICOM store:** the runtime service account (`flowrad-app`) with `roles/healthcare.dicomEditor` **on that store**. That role includes `dicomWebRead` and `dicomWebWrite`. It is not `roles/healthcare.datasetAdmin`, and it is not `allUsers`.
- **Token:** the metadata server, cached in `lib/gcpAuth.ts` until a minute before expiry. `GOOGLE_ACCESS_TOKEN` is only for a laptop smoke test. Leave it unset on Cloud Run.
- **Cloud Run itself** is `--allow-unauthenticated` because Better Auth is the gate. The DICOM store has no public invoker.

## Region, warmth, cache

Pick one region and put all three in it: Cloud Run, the Healthcare dataset, the frame bucket. `us-east4` matches Fly `iad` (Ashburn). `asia-south1` if the class is in India. The dataset location cannot be changed later; moving means export and import. `healthcare.googleapis.com` is a global hostname; the store behind it is regional, so the app has to run beside it.

Gemini (`generativelanguage.googleapis.com`) is a global API. Same-region Cloud Run does not speed up the tutor. It speeds up pixels.

| Knob | Value | Why |
|---|---|---|
| `min-instances` | 1, and 2 during a live class | The first slice should not wait for Node to boot |
| CPU | 2, always allocated (`--no-cpu-throttling`), startup CPU boost | Throttled CPU after idle makes the next frame wait |
| Memory | 2 GiB | Matches the current Fly size |
| Concurrency | 40 | A frame response holds the request open while it streams |
| Max instances | 10 | Raise before a large course |
| Timeout | 300s | Zipped study uploads |
| Startup probe | `GET /` | Cloud Run will not send traffic until the process answers |
| Public CDN | no | Frames are `Cache-Control: private`. A CDN would ignore them or, if someone marked them public, share pixels across tenants |
| Object cache | optional, same region | `R2_ENDPOINT=https://storage.googleapis.com` reuses `lib/r2.ts`. 25 ms budget, then the store. Repeat opens skip Healthcare. First open does not wait on the bucket |

Atlas still needs a network path. Either allow the Cloud Run egress range, or put a Cloud NAT in this region and allow that address. Do not open `0.0.0.0/0` on the DICOM store; it is not reachable that way. Atlas is the thing that needs an allow-list.

Raise the DICOM store read quota before a class. A room of students scrolling is a lot of WADO-RS. HTTP 429 is the symptom. Google's conformance statement documents 429; the numeric quota is the project's, so confirm it in Cloud Console rather than guessing a limit here.

## What the code does

`DICOMWEB_BACKEND=healthcare` (or Healthcare configured and `ORTHANC_URL` unset) selects the store. `ORTHANC_URL` without that flag stays Orthanc, including when Healthcare variables are also present, so a laptop does not flip by accident.

| Piece | Behavior |
|---|---|
| `lib/imagingBackend.ts` | Backend choice, dicomWeb root, Accept normalization |
| `lib/gcpAuth.ts` | Metadata-server bearer token |
| `lib/healthcareDicom.ts` | QIDO-RS for series/instance lists, STOW-RS for ingest. Pages instance search past the default cap of 1,000 |
| `lib/orthanc.ts` | Same function names. Healthcare ids **are** DICOM UIDs. `imagingStudyKey` ignores a stored Orthanc hash and looks up the StudyInstanceUID, so a Mongo row written on Fly still resolves |
| `app/api/dicomweb/[...path]/route.ts` | Proxies to `dicomWebRoot()`. Read-only. No STOW through this route |
| `app/api/upload/route.ts` | De-id, then store. If QIDO lags STOW, the batch still returns the UIDs parsed from the file |
| `components/CornerstoneViewer.tsx` | Retrieval pool 16 / 8 / 8 |
| `components/student/prefetch.ts` | Frame Accept matches Cornerstone (`transfer-syntax=*`) |
| `lib/r2.ts` | `R2_ENDPOINT` optional. Unset, the client is still Cloudflare R2 |

`orthancConfigured()` is true when the **active** archive is configured. Admin status and upload keep the existing `ORTHANC_NOT_CONFIGURED` code so the UI does not change.

## Env mapping

Placeholders. Put values in Secret Manager (`setup.sh` creates the secret **names** only).

| Fly secret / env | Cloud Run | Notes |
|---|---|---|
| `ORTHANC_URL` | unset | Do not point this at `healthcare.googleapis.com` |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | unset | Store auth is the service account |
| `DICOMWEB_BACKEND` | `healthcare` | Plain env |
| `HEALTHCARE_PROJECT` | `your-gcp-project` | Plain env |
| `HEALTHCARE_LOCATION` | `us-east4` | Same as the Cloud Run region |
| `HEALTHCARE_DATASET` | `flowrad` | Plain env |
| `HEALTHCARE_DICOM_STORE` | `flowrad-dicom` | Plain env |
| `HEALTHCARE_DICOMWEB_URL` | optional full root | Overrides the four ids. No trailing slash |
| `GOOGLE_ACCESS_TOKEN` | unset | Metadata server on Cloud Run |
| `GEMINI_API_KEY` | secret `GEMINI_API_KEY` | STT, tutor, structure, grade, Gemini TTS, Live mint |
| `GEMINI_MODEL` | `gemini-3.7-flash` | Plain env |
| `GEMINI_TIMEOUT_MS` | `45000` | Plain env |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Plain env |
| `GEMINI_TTS_VOICE` | `Kore` | Plain env |
| `GEMINI_LIVE_MODEL` | `gemini-live-2.5-flash-native-audio` | Plain env |
| `VOICE_LATENCY_BUDGET_MS` | `1200` | Plain env |
| `ELEVENLABS_API_KEY` | secret, optional | Live tutor clone. Gemini TTS covers the gap |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2` | Plain env |
| `MONGODB_URI` / `MONGODB_DB` | secret / `flowrad` | Atlas. JSON-on-disk is not durable on Cloud Run |
| `BETTER_AUTH_SECRET` | secret | Required in production |
| `BETTER_AUTH_URL` | the Cloud Run URL | `deploy-app.sh` sets it from the service URL when you leave it empty |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secrets, optional | Redirect: `{BETTER_AUTH_URL}/api/auth/callback/google` |
| `DEMO_AUTH_ENABLED` | `0` | Plain env |
| `R2_*` | optional | Unset: no object cache, reads go to the DICOM store. GCS: `R2_ENDPOINT=https://storage.googleapis.com`, `R2_BUCKET`, HMAC in `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. Leave `R2_PUBLIC_BASE_URL` unset |
| `FRAME_CACHE_WAIT_MS` | `25` | `0` skips the cache read |
| `DATA_DIR` | unset | Do not rely on the container filesystem |

`deploy/gcp/env.example` lists the shell variables for the scripts. `deploy/gcp/terraform/terraform.tfvars.example` lists the Terraform ones.

## Deploy

Scripts are the path that orders the steps. Terraform (`deploy/gcp/terraform`) creates the same APIs, Artifact Registry, service account, dataset, DICOM store, bucket, and secret shells. It does **not** create the Cloud Run service unless `deploy_app = true`, and that requires an image plus secret versions already added.

```bash
cp deploy/gcp/env.example deploy/gcp/env.local   # gitignored
# edit PROJECT_ID and REGION
set -a && source deploy/gcp/env.local && set +a
deploy/gcp/setup.sh

printf '%s' "$GEMINI_API_KEY"       | gcloud secrets versions add GEMINI_API_KEY --data-file=-
printf '%s' "$BETTER_AUTH_SECRET"   | gcloud secrets versions add BETTER_AUTH_SECRET --data-file=-
printf '%s' "$MONGODB_URI"          | gcloud secrets versions add MONGODB_URI --data-file=-

deploy/gcp/deploy-app.sh
```

Image only, from Cloud Build (no secrets in the build):

```bash
gcloud builds submit --config deploy/gcp/cloudbuild.yaml \
  --substitutions=_REGION=us-east4
SKIP_BUILD=1 \
IMAGE=us-east4-docker.pkg.dev/your-gcp-project/flowrad/app:latest \
deploy/gcp/deploy-app.sh
```

The image is the existing `Dockerfile` (Next standalone, webpack, not Turbopack). Cloud Run sets `PORT=8080`.

Terraform, after `terraform.tfvars` exists:

```bash
cd deploy/gcp/terraform
terraform init
terraform apply          # dataset, store, IAM, secrets — not the app
# add secret versions, build the image, then:
# deploy_app = true and app_image = "...", terraform apply
```

Runtime service account on the store:

```bash
gcloud healthcare dicom-stores get-iam-policy flowrad-dicom \
  --dataset=flowrad --location=us-east4
```

You want `roles/healthcare.dicomEditor` for `flowrad-app@your-gcp-project.iam.gserviceaccount.com`, and no `allUsers`.

## Local Orthanc

Unchanged. Do not set `DICOMWEB_BACKEND=healthcare` in `.env.local` if `ORTHANC_URL` points at localhost.

```bash
docker compose -f docker-compose.orthanc.yml up -d
```

`.env.local`: `ORTHANC_URL=http://127.0.0.1:8042`, `ORTHANC_USER=flowrad`, `ORTHANC_PASSWORD=flowrad`. The compose file uses that password. Fly's private Orthanc (`fly.orthanc.toml`, `http://flowrad-orthanc.internal:8042`) is still the deploy in `docs/FLY_R2.md`.

## Checklist — Fly to Cloud Run

1. Choose the region (`us-east4` or `asia-south1`) and a project id. Write them only in `deploy/gcp/env.local` and `terraform.tfvars`, not in git.
2. Run `deploy/gcp/setup.sh`. Confirm the DICOM store and that its IAM policy is the runtime service account, not the public.
3. Add secret versions for `GEMINI_API_KEY`, `BETTER_AUTH_SECRET`, and `MONGODB_URI`. Add Google OAuth and ElevenLabs versions if you use them.
4. Allow Atlas to the Cloud Run egress (or a Cloud NAT address in this region).
5. Build and `deploy/gcp/deploy-app.sh`. Confirm `BETTER_AUTH_URL` is the service URL. Set the Google OAuth redirect to `{BETTER_AUTH_URL}/api/auth/callback/google`.
6. Re-import studies. The Fly volume does not move. `orthancStudyId` values already in Mongo are Orthanc hashes; on this backend the app looks up by StudyInstanceUID (`imagingStudyKey`). New uploads store the UID in that field.
7. Smoke test as a student: open a case, scroll a series, ask the tutor a question. First frame should not wait on a cold start. A second open of the same frame should be fast (browser cache, or `x-flowrad-cache: hit` if the bucket is configured).
8. Smoke test as an author: upload one already-de-identified instance. A file with a real patient name must be refused. Confirm the instance is in the store (`gcloud healthcare dicom-stores` / a QIDO from the app, not from the public internet).
9. Before a class, set `MIN_INSTANCES=2` and check the DICOM read quota.
10. Leave Fly running until steps 7 and 8 pass. Then scale the Fly apps down. Do not delete the Orthanc volume until you have opened every published case on Cloud Run.
11. Optional: create an HMAC key for `flowrad-app`, store it as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, set `FRAME_BUCKET`, redeploy. Frames stay private.

## Out of scope

- Vertex AI instead of the Gemini API key. The app already calls Gemini with `GEMINI_API_KEY`; Cloud Run just needs egress to Google.
- A public CDN or signed browser URLs for pixels.
- Orthanc as a second Cloud Run service.
- Healthcare de-identify as a substitute for `lib/deid.ts`.
- Pixel OCR. Still not implemented, still not claimed.
