# Fly.io + Cloudflare R2

Locked infra for FlowRad Learn. Product decisions: `docs/DECISIONS.md`.

## Two Fly apps

| File | App | Public? |
|------|-----|---------|
| `fly.toml` | `flowrad-learn` (Next.js) | Yes (HTTPS) |
| `fly.orthanc.toml` | `flowrad-orthanc` | **No** — private 6PN only |

```bash
fly deploy -c fly.toml
fly volumes create orthanc_data -a flowrad-orthanc --size 50 -r iad
fly deploy -c fly.orthanc.toml
```

The Next image is `Dockerfile` (standalone output). Do not build with `--turbo`.

### Private networking

Orthanc has **no** `[http_service]`. It listens on 8042 inside the Fly IPv6 private network. The app reaches it as:

```
ORTHANC_URL=http://flowrad-orthanc.internal:8042
```

- Same Fly org only. The browser never talks to Orthanc; it uses `/api/dicomweb`.
- Do **not** `fly ips allocate-v4` on Orthanc. Optional Flycast: `fly ips allocate-v6 --private -a flowrad-orthanc`.
- Confirm: `fly ips list -a flowrad-orthanc` (no public IPv4).

## Environment

Set as **Fly secrets** on `flowrad-learn` (never in `[env]` for credentials).

| Variable | Required | Purpose |
|----------|----------|---------|
| `ORTHANC_URL` | for imaging | `http://flowrad-orthanc.internal:8042` |
| `ORTHANC_USER` / `ORTHANC_PASSWORD` | for imaging | Basic auth; match Orthanc `REGISTERED_USERS` |
| `MONGODB_URI` / `MONGODB_DB` | prod | Atlas. Unset → JSON under `DATA_DIR` |
| `DATA_DIR` | optional | `/app/data` if using an app volume |
| `GEMINI_API_KEY` | for tutor/STT | Gemini Flash |
| `R2_ACCOUNT_ID` | for R2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | for R2 | R2 API token |
| `R2_SECRET_ACCESS_KEY` | for R2 | R2 API token secret |
| `R2_BUCKET` | for R2 | Bucket name |
| `R2_PUBLIC_BASE_URL` | optional | CDN / `*.r2.dev` origin for `getObjectUrl` |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | auth | `lib/auth.ts` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | Google OAuth |

When R2 vars are unset, `r2Configured()` is false and `putObject` / `getSignedGetUrl` no-op. Audio stays on `DATA_DIR` (`lib/audioStore.ts`). Build does not require R2.

## R2 seam (`lib/r2.ts`)

S3-compatible client (`@aws-sdk/client-s3`) against `https://<account>.r2.cloudflarestorage.com`.

- `r2Configured()` — all four write creds present
- `putObject(key, body, contentType)` — null when unset
- `getObject(key)` — bytes for `/api/audio` and frame cache
- `getObjectUrl(key)` — public URL if `R2_PUBLIC_BASE_URL` is set, else null
- `getSignedGetUrl(key, expiresIn?)` — private GET; null when unset

Audio URLs stay same-origin `/api/audio/<id>` so the client never sees bucket credentials.

## De-id ingest gate (`lib/deid.ts`)

`orthancIngestInstance` inspects DICOM headers and **refuses residual identity tags** (PatientName / PatientID / DOB / physician names / …). Anonymous sentinels (`Anonymous`, `ANON`) pass. Institution name and PatientSex do not fail ingest. Pixel OCR is **not** claimed (`pixelOcrScanned: false`) until a real scanner exists.

## Prefetch (≤30s interactive)

- Case list: `CasesPrefetcher` warms manifests in `Promise.allSettled` batches of 4.
- Case open: finding-first series[0] immediately, then other series in parallel batches of 3 (`components/student/prefetch.ts`). Never download a full 2–3 GB CTA up front.
