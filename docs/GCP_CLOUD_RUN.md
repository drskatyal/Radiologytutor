# RadLearn on Cloud Run

Production deploy for **RadLearn**. GCP project id **`radlearn-app`** (display name RadLearn; the id `radlearn` was unavailable). Region **`europe-west2`** (London).

The Next.js app runs on **Cloud Run**. Study bytes live in a **Cloud Healthcare API DICOM store** in the same region. Cases, accounts, and progress live in **MongoDB Atlas** (Atlas region `EUROPE_WEST_2`). Secrets live in **Secret Manager**. The browser still talks only to `/api/dicomweb`.

Teach-mode fidelity on a real case is proven, including the tour check-in. This path is ready to deploy. Local Orthanc remains for laptops. Fly stays up until the cutover checklist below has been run; that checklist is the apply procedure, not a hold.

This is the fastest way to open a study **on Cloud Run**. A warm Orthanc process with a local SSD can beat a regional API for one reader. Cloud Run has no local disk, so that shape is not available here. Putting Orthanc on Cloud Run makes it worse: the app would call a second Cloud Run service, which would call Cloud SQL and then GCS. The Healthcare store is that storage without the extra process.

We have not run Google's `healthcare-imaging-performance-test` in this repo. The FPS figures below are from [DICOM best practices](https://docs.cloud.google.com/healthcare-api/docs/how-tos/dicom-best-practices) (page updated 2026-05-20), for 0.5 MB frames, same region, no compression. Treat them as Google's number, not ours.

## Request path — student opens a case

```
browser  →  Cloud Run (Next.js, min instances ≥ 1, project radlearn-app, europe-west2)
              ├─ Better Auth session
              ├─ org owns this StudyInstanceUID
              └─ GET https://healthcare.googleapis.com/v1/projects/radlearn-app/locations/europe-west2/datasets/radlearn/dicomStores/radlearn-dicom/dicomWeb/...
                   Authorization: Bearer <runtime service account>
```

1. The learner opens `/case/[caseId]`. Cloud Run is already up (`min-instances` ≥ 1, CPU always allocated), so this request does not pay a container boot.
2. The server builds the prefetch manifest. Series and instance lists are QIDO-RS against the DICOM store (`lib/orthanc.ts` → `lib/healthcareDicom.ts`). That is metadata, not pixels.
3. Cornerstone loads series metadata, then frames, all as same-origin `GET /api/dicomweb/studies/{study}/series/{series}/...`. The route is `app/api/dicomweb/[...path]/route.ts`.
4. The route checks the session, then that the caller's org holds that StudyInstanceUID (unchanged). It does not accept a client-supplied `orgId`.
5. Frame reads may check the private object cache for at most `FRAME_CACHE_WAIT_MS` (default 25). A slow or empty cache does not sit in front of the first slice. On a miss the route calls the DICOM store and streams the body back.
6. Upstream Accept on frames is the Cornerstone wadors value (`multipart/related; type=application/octet-stream; transfer-syntax=*`) unless the client already sent `multipart/related`. That skips Healthcare's transcode. The policy lives in `lib/dicomwebProxy.ts` (the same helper Teach uses so a prefetch 400 cannot be cached). Rendered thumbnails pass through jpeg/png when the client asked for one, otherwise `image/jpeg`.
7. Successful frame responses are `Cache-Control: private, immutable` plus `Vary: Accept`. **4xx and 5xx are not cached.** A shared cache must not store these bytes.
8. Cornerstone decodes in up to 4 web workers. The retrieval pool allows 16 interaction requests (the library default is 6). Prefetch (`components/student/prefetch.ts`) warms the slice the stack opens on and a short window around each finding (cap 18, concurrency 3) with that same Accept. It does not pull the first 32 slices of the series.
9. Voice is a different path and does not touch the DICOM store. `/api/transcribe` and `/api/tutor` call Gemini with `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.8-flash`. `/api/tts` uses ElevenLabs when the teacher has a clone, otherwise Gemini TTS. If that exceeds `VOICE_LATENCY_BUDGET_MS`, `/api/voice/realtime` mints a short-lived token and the browser opens Gemini Live itself. The key never goes to the client. TTS and Live stay on the tip model ids (`gemini-2.5-flash-preview-tts`, `gemini-live-2.5-flash-native-audio`).

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
| Scroll | HTTP/2 to one origin. Pool of 16. Google's guide: same region, 0.5 MB frames, about 30 FPS at 6 in flight and about 60 FPS at 20. Prefetch warms the open slice and finding windows, not a 32-slice prefix. | Same browser work, plus Orthanc's concurrency cap and the SQL/GCS hop on every miss. | Excellent until the disk or the one process saturates. |
| Ops | One Cloud Run service, one dataset, one DICOM store, one service account, Atlas for the domain database. | Two services, Cloud SQL, the GCS plugin, a VPC path to private SQL. SQLite on a bucket will corrupt. | Patch the VM, the disk, and failover yourself. |
| Cost shape | DICOM storage and DICOMweb operations, plus one always-on Cloud Run instance (the price of no cold start). No Cloud SQL. | That, plus Cloud SQL always-on and a second minimum instance. | One VM always on. |
| Upload / de-id | Header gate, then STOW-RS. Ids returned to the app are DICOM UIDs. | Header gate, then Orthanc `POST /instances`. Ids are Orthanc hashes. | Same as Orthanc. |

Orthanc on Cloud Run is not in the deploy scripts. `docker-compose.orthanc.yml` and `fly.orthanc.toml` are the Orthanc paths that still exist for local and Fly.

## Database — MongoDB Atlas, not JSON

`lib/cases.ts` uses JSON under `DATA_DIR` only when `MONGODB_URI` is unset. That is the dev and test fallback. **Cloud Run sets `K_SERVICE`. If `MONGODB_URI` is missing, the data layer and Better Auth refuse to start** (`lib/durableStore.ts`) so a revision cannot silently write cases onto the container filesystem.

Atlas is the database. It fits the existing `MONGODB_URI` / `MONGODB_DB` seam. Nothing in `lib/cases.ts` is rewritten for GCP.

| Setting | Value |
|---|---|
| Atlas cloud / region | GCP, **`EUROPE_WEST_2`** (London — the same metro as `europe-west2`) |
| GCP project for the app | `radlearn-app` |
| Database name | `radlearn` (`MONGODB_DB`) |
| Connection string | Secret Manager secret `MONGODB_URI` only. Never in git, never in a plain env var on the command line you commit |
| JSON / `DATA_DIR` | Unset on Cloud Run |

Day-one network path (what `setup.sh` creates):

1. VPC `radlearn`, subnet `radlearn-run` (`10.8.0.0/24`) in `europe-west2`, Private Google Access on.
2. Cloud NAT `radlearn-nat` with reserved address `radlearn-egress`.
3. Cloud Run Direct VPC egress **`all-traffic`**, so Atlas sees that one address.
4. On the Atlas cluster, Network Access allows **only** that IP. Do not allow `0.0.0.0/0`.

`setup.sh` prints the address. `terraform output atlas_egress_ip` is the same value.

Preferred follow-up, once the Atlas project is linked: **Private Service Connect**. Create the Atlas private endpoint in subnet `radlearn-run`, store the private connection string as a new `MONGODB_URI` version, and set `VPC_EGRESS=private-ranges-only`. Healthcare and Gemini then skip the NAT (Private Google Access still covers `*.googleapis.com`). Until that endpoint exists, `all-traffic` is the path that actually reaches a public Atlas hostname.

Atlas itself is not created by these scripts. There is no Atlas API credential in this repo.

## Auth

The browser does not hold a Google token for the DICOM store, and it does not receive a signed DICOM URL. The Healthcare API has no presigned WADO-RS URL. IAP in front of the app would be a second login and would not authorize the store.

- **Learners and teachers:** Better Auth session on `/api/dicomweb` and `/api/upload`, then the org-ownership check.
- **Cloud Run → DICOM store:** the runtime service account (`radlearn-app@radlearn-app.iam.gserviceaccount.com`) with `roles/healthcare.dicomEditor` **on that store**. That role includes `dicomWebRead` and `dicomWebWrite`. It is not `roles/healthcare.datasetAdmin`, and it is not `allUsers`.
- **Token:** the metadata server, cached in `lib/gcpAuth.ts` until a minute before expiry. `GOOGLE_ACCESS_TOKEN` is only for a laptop smoke test. Leave it unset on Cloud Run.
- **Cloud Run itself** is `--allow-unauthenticated` because Better Auth is the gate. The DICOM store has no public invoker.
- **Secrets:** `GEMINI_API_KEY`, `BETTER_AUTH_SECRET`, and `MONGODB_URI` are required versions. Google OAuth, ElevenLabs, and the GCS HMAC are attached only when a version exists.

## Region, warmth, cache

Everything regional sits in **`europe-west2`**: Cloud Run, the Healthcare dataset, the subnet, Cloud NAT, and the frame bucket if you create one. The dataset location cannot be changed later; moving means export and import. `healthcare.googleapis.com` is a global hostname; the store behind it is regional, so the app runs beside it.

Gemini (`generativelanguage.googleapis.com`) is a global API. Same-region Cloud Run does not speed up the tutor. It speeds up pixels. With `VPC_EGRESS=all-traffic`, Private Google Access on the subnet keeps Google APIs on Google's network instead of a public detour. Atlas, which is not a Google API, uses the NAT IP.

| Knob | Value | Why |
|---|---|---|
| `min-instances` | 1, and 2 during a live class | The first slice should not wait for Node to boot |
| CPU | 2, always allocated (`--no-cpu-throttling`), startup CPU boost | Throttled CPU after idle makes the next frame wait |
| Memory | 2 GiB | Matches the current Fly size |
| Concurrency | 40 | A frame response holds the request open while it streams |
| Max instances | 10 | Raise before a large course |
| Timeout | 300s | Zipped study uploads |
| Startup probe | `GET /` | Cloud Run will not send traffic until the process answers |
| VPC egress | `all-traffic` until Atlas PSC, then `private-ranges-only` | Atlas IP allowlist vs DICOM not hairpinning through NAT |
| Public CDN | no | Frames are `Cache-Control: private` |
| Object cache | optional, same region | `R2_ENDPOINT=https://storage.googleapis.com` reuses `lib/r2.ts`. 25 ms budget, then the store |

Raise the DICOM store read quota before a class. A room of students scrolling is a lot of WADO-RS. HTTP 429 is the symptom. Google's conformance statement documents 429; the numeric quota is the project's, so confirm it in Cloud Console rather than guessing a limit here.

## What the code does

`DICOMWEB_BACKEND=healthcare` (or Healthcare configured and `ORTHANC_URL` unset) selects the store. `ORTHANC_URL` without that flag stays Orthanc, including when Healthcare variables are also present, so a laptop does not flip by accident.

| Piece | Behavior |
|---|---|
| `lib/imagingBackend.ts` | Backend choice and dicomWeb root |
| `lib/dicomwebProxy.ts` | Accept and Cache-Control for `/api/dicomweb`. Errors are not stored |
| `lib/gcpAuth.ts` | Metadata-server bearer token |
| `lib/healthcareDicom.ts` | QIDO-RS for series/instance lists, STOW-RS for ingest. Pages instance search past the default cap of 1,000 |
| `lib/orthanc.ts` | Same function names. Healthcare ids **are** DICOM UIDs. `imagingStudyKey` ignores a stored Orthanc hash and looks up the StudyInstanceUID, so a Mongo row written on Fly still resolves |
| `lib/durableStore.ts` | Cloud Run without `MONGODB_URI` throws |
| `app/api/dicomweb/[...path]/route.ts` | Proxies to `dicomWebRoot()`. Read-only. No STOW through this route |
| `app/api/upload/route.ts` | De-id, then store. If QIDO lags STOW, the batch still returns the UIDs parsed from the file |
| `components/CornerstoneViewer.tsx` | Retrieval pool 16 / 8 / 8 |
| `components/student/prefetch.ts` | Tip warmer: open slice and finding windows, Cornerstone Accept |
| `lib/r2.ts` | `R2_ENDPOINT` optional. Unset, the client is still Cloudflare R2 |

`orthancConfigured()` is true when the **active** archive is configured. Admin status and upload keep the existing `ORTHANC_NOT_CONFIGURED` code so the UI does not change.

## Env mapping

Project, region, and model below are the deploy defaults. Secret **values** are added by you after `setup.sh` creates the secret names. Nothing here is a credential.

| Fly secret / env | Cloud Run | Notes |
|---|---|---|
| `ORTHANC_URL` | unset | Do not point this at `healthcare.googleapis.com` |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | unset | Store auth is the service account |
| `DICOMWEB_BACKEND` | `healthcare` | Plain env |
| `HEALTHCARE_PROJECT` | `radlearn-app` | Plain env |
| `HEALTHCARE_LOCATION` | `europe-west2` | Same as the Cloud Run region |
| `HEALTHCARE_DATASET` | `radlearn` | Plain env |
| `HEALTHCARE_DICOM_STORE` | `radlearn-dicom` | Plain env |
| `HEALTHCARE_DICOMWEB_URL` | optional full root | Overrides the four ids. No trailing slash |
| `GOOGLE_ACCESS_TOKEN` | unset | Metadata server on Cloud Run |
| `GEMINI_API_KEY` | secret `GEMINI_API_KEY` | STT, tutor, structure, grade, Gemini TTS, Live mint |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Plain env. Stable GA. Code default matches |
| `GEMINI_TIMEOUT_MS` | `45000` | Plain env |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Plain env. Tip id, unchanged |
| `GEMINI_TTS_VOICE` | `Kore` | Plain env |
| `GEMINI_LIVE_MODEL` | `gemini-live-2.5-flash-native-audio` | Plain env. Tip id, unchanged |
| `VOICE_LATENCY_BUDGET_MS` | `1200` | Plain env |
| `ELEVENLABS_API_KEY` | secret, optional | Live tutor clone. Gemini TTS covers the gap |
| `ELEVENLABS_TTS_MODEL` | `eleven_multilingual_v2` | Plain env |
| `MONGODB_URI` | secret `MONGODB_URI` | Atlas SRV URI. Required. Missing → process error, not JSON |
| `MONGODB_DB` | `radlearn` | Plain env. App-code fallback when unset is still `flowrad` (Fly/local) |
| `BETTER_AUTH_SECRET` | secret | Required in production |
| `BETTER_AUTH_URL` | the Cloud Run URL | `deploy-app.sh` sets it from the service URL when you leave it empty |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secrets, optional | Redirect: `{BETTER_AUTH_URL}/api/auth/callback/google` |
| `DEMO_AUTH_ENABLED` | `0` | Plain env |
| `R2_*` | optional | Unset: no object cache, reads go to the DICOM store. GCS: `R2_ENDPOINT=https://storage.googleapis.com`, `R2_BUCKET`, HMAC in `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. Leave `R2_PUBLIC_BASE_URL` unset |
| `FRAME_CACHE_WAIT_MS` | `25` | `0` skips the cache read |
| `DATA_DIR` | unset | Do not rely on the container filesystem |
| `VPC_EGRESS` | `all-traffic` | `private-ranges-only` after Atlas PSC |

`deploy/gcp/env.example` lists the shell variables for the scripts. `deploy/gcp/terraform/terraform.tfvars.example` lists the Terraform ones. Both default to project `radlearn-app` and region `europe-west2`.

## Deploy

Scripts are the path that orders the steps. Terraform (`deploy/gcp/terraform`) creates the same APIs, Artifact Registry, service account, dataset, DICOM store, bucket, secret shells, VPC, and Cloud NAT. It does **not** create the Cloud Run service unless `deploy_app = true`, and that requires an image plus secret versions already added. These files were not applied from this environment (no GCP credentials here).

```bash
cp deploy/gcp/env.example deploy/gcp/env.local   # gitignored
# PROJECT_ID and REGION are already radlearn-app / europe-west2
set -a && source deploy/gcp/env.local && set +a
deploy/gcp/setup.sh
# note the printed Atlas egress IP and allow only that IP on the EUROPE_WEST_2 cluster

printf '%s' "$GEMINI_API_KEY"       | gcloud secrets versions add GEMINI_API_KEY --data-file=-
printf '%s' "$BETTER_AUTH_SECRET"   | gcloud secrets versions add BETTER_AUTH_SECRET --data-file=-
printf '%s' "$MONGODB_URI"          | gcloud secrets versions add MONGODB_URI --data-file=-

deploy/gcp/deploy-app.sh
```

Image only, from Cloud Build (no secrets in the build):

```bash
gcloud builds submit --config deploy/gcp/cloudbuild.yaml --project=radlearn-app \
  --substitutions=_REGION=europe-west2,_REPO=radlearn
SKIP_BUILD=1 \
IMAGE=europe-west2-docker.pkg.dev/radlearn-app/radlearn/app:latest \
deploy/gcp/deploy-app.sh
```

The image is the existing `Dockerfile` (Next standalone, webpack, not Turbopack). Cloud Run sets `PORT=8080`.

Terraform, after `terraform.tfvars` exists:

```bash
cd deploy/gcp/terraform
terraform init
terraform apply          # dataset, store, IAM, secrets, VPC, NAT — not the app
# allow atlas_egress_ip on Atlas, add secret versions, build the image, then:
# deploy_app = true and app_image = "europe-west2-docker.pkg.dev/radlearn-app/radlearn/app:latest"
terraform apply
```

Runtime service account on the store:

```bash
gcloud healthcare dicom-stores get-iam-policy radlearn-dicom \
  --dataset=radlearn --location=europe-west2 --project=radlearn-app
```

You want `roles/healthcare.dicomEditor` for `radlearn-app@radlearn-app.iam.gserviceaccount.com`, and no `allUsers`.

## Local Orthanc

Unchanged. Do not set `DICOMWEB_BACKEND=healthcare` in `.env.local` if `ORTHANC_URL` points at localhost.

```bash
docker compose -f docker-compose.orthanc.yml up -d
```

`.env.local`: `ORTHANC_URL=http://127.0.0.1:8042`, `ORTHANC_USER=flowrad`, `ORTHANC_PASSWORD=flowrad`. The compose file uses that password. Fly's private Orthanc (`fly.orthanc.toml`, `http://flowrad-orthanc.internal:8042`) is still the deploy in `docs/FLY_R2.md`.

## Checklist — Fly to Cloud Run

1. Confirm project `radlearn-app` and region `europe-west2`. The values in `deploy/gcp/env.example` already match. Keep filled-in secrets in `deploy/gcp/env.local` and `terraform.tfvars`, not in git.
2. Create the Atlas cluster on GCP in **`EUROPE_WEST_2`**, database user, database `radlearn`.
3. Run `deploy/gcp/setup.sh`. Confirm the DICOM store IAM is the runtime service account, not the public. Copy the printed egress IP into the Atlas allowlist (that IP only).
4. Add secret versions for `GEMINI_API_KEY`, `BETTER_AUTH_SECRET`, and `MONGODB_URI`. Add Google OAuth and ElevenLabs versions if you use them.
5. Build and `deploy/gcp/deploy-app.sh`. Confirm `BETTER_AUTH_URL` is the service URL and `GEMINI_MODEL` is `gemini-3.8-flash`. Set the Google OAuth redirect to `{BETTER_AUTH_URL}/api/auth/callback/google`.
6. Re-import studies. The Fly volume does not move. `orthancStudyId` values already in Mongo are Orthanc hashes; on this backend the app looks up by StudyInstanceUID (`imagingStudyKey`). New uploads store the UID in that field.
7. Smoke test as a student: open a case, scroll a series, ask the tutor a question. First frame should not wait on a cold start. A second open of the same frame should be fast (browser cache, or `x-flowrad-cache: r2` if the bucket is configured).
8. Smoke test as an author: upload one already-de-identified instance. A file with a real patient name must be refused. Confirm the instance is in the store (`gcloud healthcare dicom-stores` / a QIDO from the app, not from the public internet). Confirm a case save lands in Atlas, not in the container.
9. Before a class, set `MIN_INSTANCES=2` and check the DICOM read quota.
10. Leave Fly running until steps 7 and 8 pass. Then scale the Fly apps down. Do not delete the Orthanc volume until you have opened every published case on Cloud Run.
11. Optional: create an HMAC key for `radlearn-app`, store it as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, set `FRAME_BUCKET` (for example `radlearn-app-frames`), redeploy. Frames stay private.
12. Optional later: Atlas Private Service Connect in `radlearn-run`, then `VPC_EGRESS=private-ranges-only`.

## Out of scope

- Applying `gcloud` or Terraform from a machine that does not have the flowradai1 credentials. The scripts are ready; they were not applied here.
- Vertex AI instead of the Gemini API key. The app already calls Gemini with `GEMINI_API_KEY`; Cloud Run just needs egress to Google.
- A public CDN or signed browser URLs for pixels.
- Orthanc as a second Cloud Run service.
- Healthcare de-identify as a substitute for `lib/deid.ts`.
- Pixel OCR. Still not implemented, still not claimed.
- Renaming the Fly app, Better Auth dev secret, or in-product FlowRad strings. Those are not GCP deploy defaults.
