# Runtime environment contract — C2 storage and Step B startup

`lib/envSchema.ts` is the typed name/classification contract. Diagnostics list
names only. Values for secrets belong in Secret Manager/runtime configuration,
never source or logs. `TRUSTED_PROXY_SECRET` appears in both lists supplied by the
orchestrator; it is classified as **secret** because it authenticates the Worker.

## Startup validation (Step B)

`validateProductionEnv` in the same typed module runs once through the production
Node preload, before Next can start listening. `npm run build` compiles that
schema into `.next/standalone/runtime/envSchema.cjs`; it neither reads production
values nor validates the build host. Docker and repository `npm start` both
preload `startup-check.cjs`. Missing or invalid settings produce a variable-name
list and exit 1, with no values, client initialization or external calls.

The production launcher defaults `NODE_ENV` to production and `PORT` to 8080.
An explicitly different NODE_ENV is rejected; there is no test-mode bypass.
Cloud Run's injected PORT overrides the default and must be an integer from
1 to 65535. PORT and HOSTNAME are platform transport settings, not new secrets.
The image listens on `0.0.0.0`. A missing compiled preload also fails startup.
`next dev` and the local fixture harness do not invoke this production launcher.

Production requires Healthcare, the four resource identifiers (no path or URL
injection), a Mongo database name and URI, a bare GCS bucket, a public origin
and the required secret names below. BETTER_AUTH_URL must be an HTTPS origin
without userinfo, path, query or fragment; HTTP loopback is allowed for local
production smoke checks. Deadlines must be positive integer milliseconds;
FRAME_CACHE_WAIT_MS can be zero. Demo flags are 0/1 and student/author. Google
OAuth ID/secret must be supplied together. Validation checks syntax/presence,
not network reachability, IAM permissions or secret correctness.

Production **must set `BETTER_AUTH_URL=https://learn.flowrad.ai`**, the public
front door used for authentication callbacks and origin fallback. Never use a
`*.workers.dev` preview or a Cloud Run `run.app` URL for this production setting.
The required-at-startup check remains unchanged. Root `.env.example` keeps
`http://localhost:3000` for local development only.

The PACS variables inherited from the existing implementation are the Healthcare
rows below and optional local `ORTHANC_*` compatibility settings. No separate
Step A web-PACS schema or additional PACS env names exist on this checkout;
none are invented. Desktop DIMSE node settings remain desktop-local. See
[CLOUD_RUN.md](CLOUD_RUN.md) for the deployment handoff and validation limits.

| Names | Class | Required in production |
| --- | --- | --- |
| `NODE_ENV` | Plain | Yes, production |
| `DICOMWEB_BACKEND` | Plain | Yes, healthcare |
| `HEALTHCARE_PROJECT`, `HEALTHCARE_LOCATION`, `HEALTHCARE_DATASET`, `HEALTHCARE_DICOM_STORE` | Plain | Yes: radlearn-app, europe-west2, radlearn, radlearn-dicom respectively |
| `MONGODB_DB` | Plain | Yes; Mongo remains the authoritative case/approval store |
| `BETTER_AUTH_URL` | Plain | Yes; `https://learn.flowrad.ai` in production, never a workers.dev preview or run.app upstream |
| `GCS_OBJECT_BUCKET` | Plain | Yes for durable Healthcare imports/media; `radlearn-app-case-media` confirmed/adopted as REPORTED by Radlearn/GCP Admin, not verified by this checkout |
| `GEMINI_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`, `GEMINI_LIVE_MODEL` | Plain | Optional overrides of the documented adapter defaults |
| `GEMINI_TIMEOUT_MS`, `VOICE_LATENCY_BUDGET_MS`, `FRAME_CACHE_WAIT_MS` | Plain | Optional deadline/cache defaults |
| `ELEVENLABS_TTS_MODEL` | Plain | Optional model default |
| `DEMO_AUTH_ENABLED`, `DEMO_AUTH_MAX_ROLE` | Plain | Optional; production demo is off by default |
| `BETTER_AUTH_SECRET`, `MONGODB_URI`, `TRUSTED_PROXY_SECRET` | Secret | Yes |
| `GEMINI_API_KEY` | Secret | Required to enable Gemini; absent in this work, all calls mocked |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Secret | Required together to enable Google OAuth |
| `ELEVENLABS_API_KEY` | Secret | Required to enable the primary cloned-voice provider |

**REPORTED by Radlearn/GCP Admin (12 November 2026):** GCP Admin confirmed
and adopted `GCS_OBJECT_BUCKET=radlearn-app-case-media`. The bucket
`gs://radlearn-app-case-media` is private, in `europe-west2`, with
`roles/storage.objectAdmin` granted only to
`radlearn-app@radlearn-app.iam.gserviceaccount.com`.
**NOT verified by this checkout; no GCP call made.** This records the supplied
confirmation, not a local IAM or bucket inspection. The env name stays unchanged,
declared in exactly one existing env-schema constant and accessed through its
reader; no default bucket value is added to code and no secret value is recorded.
The same private bucket serves `cases/` import snapshots, `imports/` receipts,
`audio/`, cached DICOMweb responses and the existing converted series bundle
layout. The bucket must already exist; this change provisions nothing.

Production does **not** require or set `ORTHANC_*`, `R2_*`, or
`NEXT_PUBLIC_APP_URL`. Explicit `DICOMWEB_BACKEND=orthanc` plus `ORTHANC_URL`
still supports local/legacy Orthanc. Legacy R2 is only eligible outside
Healthcare/Cloud Run when no GCS bucket is configured. Local development may
still use its existing JSON/audio disk store. Healthcare/Cloud Run durable
imports and audio fail closed if the shared bucket is absent. GCS errors never
trigger R2 or disk fallback. The frame cache remains optional: a cache failure
costs a miss, not an import or archive write.

Existing optional bundle settings (`DICOM_CDN_BUCKET`, `DICOM_CDN_LOCAL_DIR`,
`DICOM_CDN_URL`, signing settings and build/disable switches) remain compatibility
options, not production requirements. With the shared bucket and no CDN URL,
the existing authenticated app proxy delivers bundles. No public bucket, signed
URL key, S3 HMAC key or separate CDN is required. The shared bucket takes priority
over the legacy bundle-only bucket setting.

## Authentication and imaging path

Healthcare root (unchanged):
`https://healthcare.googleapis.com/v1/projects/radlearn-app/locations/europe-west2/datasets/radlearn/dicomStores/radlearn-dicom/dicomWeb`.
QIDO uses `/studies`, `/series`, `/instances`; metadata and WADO are scoped under
the study/series/instance path. Upload uses multipart STOW-RS `/studies` through
the existing de-identification gate. A stored instance must be explicitly
acknowledged by SOP UID; partial failures, empty responses and unproven conflicts
are failures, not successful imports.

GCS JSON API and Healthcare share `google-auth-library` runtime ADC for the
attached Cloud Run service account
`radlearn-app@radlearn-app.iam.gserviceaccount.com`. `GoogleAuth` receives an
explicit `Compute` ADC client, avoiding key files and well-known local credential
discovery. Token refresh is handled by the library; injected access-token envs
are ignored. The bucket grant is REPORTED above, not independently verified.
DICOM-store access remains GCP Admin's responsibility. No IAM changes were
attempted.

Browser requests stay same-origin. Anonymous DICOMweb GET/HEAD returns 401
before archive configuration, ADC or network access. The existing scoped share
capability remains limited to its case's studies. The proxy stays read-only;
STOW is only available through the authenticated author upload/import path.

Mongo stores authoritative cases and approval state. GCS import snapshots use
an allowlist and PHI checks, omit identity/share/approval fields, and are not an
approval restore mechanism. Upload receipts contain UIDs and counts, never
original filenames. Multi-service writes are not atomic: if receipt/snapshot
storage fails after STOW/Mongo succeeds, the request fails and requires retry;
it does not claim rollback. A retry never reports an unproven STOW conflict as
success. Internal `Case.patientId` database references are omitted separately
from DICOM PatientID checks; they are never exported or used as object keys.

## Verification boundary

**NO LIVE GCP CALL WAS MADE.** GCS JSON API, Healthcare QIDO/WADO/STOW/metadata
and runtime token acquisition are mocked with synthetic DICOM only. Tests run
real de-identification, bundle conversion, object serialization and route
authorization. Local Playwright exercises the real Next app and its synthetic
archive. No remote import/backfill/deploy scripts were run. Gemini remains
mocked: **live contract not verified**.

`lib/c2Storage.test.ts` covers the schema, ADC isolation, private object CRUD and
ranges/pagination, no fallback on durable-write errors, case/receipt allowlists,
synthetic STOW/QIDO/WADO/bundle generation, failed acknowledgements and 401s.
`e2e/radlearn/dicomweb-auth.spec.ts` checks anonymous QIDO/metadata/pixel GET/HEAD
and the read-only proxy. Existing Orthanc and legacy R2 tests are retained.
