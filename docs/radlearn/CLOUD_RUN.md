# Cloud Run deployment handoff — files only

GCP Cloud Run, owned by **GCP Admin**, is the only deployment target. This step
prepares local files; it does not authorize or perform deployment, push, PR,
merge, GitHub Actions, IAM changes, remote data access or Railway operations.
PRs/merges remain held until the orchestrator confirms Railway's GitHub
integration and PR previews are fully disconnected. Deleting `railway.json`
does not disconnect those services. Never #130/#252/#109 or their branches.

Use the existing root Dockerfile and `deploy/gcp/` directory. This is an update
to that deployment path, not a second container definition. The existing
Terraform, Cloud Build and shell deployment files are source references only;
none of their deployment/provisioning commands was run in this work.

## Container and startup contract

- Node 24 matches the local validation runtime (24.22.1); image tags/layers
  were not pulled or verified here because Docker is unavailable.
- Three stages: dependency install, production `npm run build`, standalone
  runtime. The final image contains public/static assets, the traced Next server
  and a small compiled environment validator. No development toolchain is needed
  at runtime. Node runs as `nextjs` (UID/GID 1001).
- Listen on `0.0.0.0`; default `PORT=8080`, with the runtime's `PORT` honored.
  The image uses `node --require ./runtime/startup-check.cjs server.js`.
  The image's `npm start` points to the same checked entry point.
- Repository `npm start` preloads the same check before the Next CLI. `npm run
  build` creates the validator via `postbuild` using the already-installed
  TypeScript compiler. Builds do not need production credentials or run runtime
  validation. No new dependency was added in Step B.
- The validator imports the C2 schema, rejects missing required variables and
  malformed names/URLs/ports/durations/flags, then exits 1 before Next starts
  serving. Errors contain variable names only. Optional provider keys may be
  absent; Google OAuth settings must be present together. No credential-file,
  network, database or provider check happens during validation.
- `GET /api/healthz` returns only `{"status":"ok"}` with `Cache-Control:
  no-store`; HEAD is empty. It is a cheap process liveness endpoint, not a
  database, bucket, Gemini or DICOM availability check. Existing Cloud Run
  startup-probe definitions now use it on port 8080. It needs no session.

`npx next start` in the existing local Playwright harness is a fixture runner,
not the supported production launch command. It deliberately keeps the local
JSON store and mock Orthanc. Production preload failure/success is tested in
separate child processes; no test-mode bypass exists in that preload. Local
Orthanc development (`npm run dev`) remains available. Production Cloud Run is
Healthcare + Mongo + private GCS, as required by the C2 schema.

The Docker source COPY list and `.dockerignore` exclude env files, credential
directories, private keys, local databases and browser/test state. No secret
build args or ENV values are used. The only build arg is the public commit SHA.
Secrets must be injected at runtime from Secret Manager; never supply them as
Docker build arguments, files in the context, or public browser variables.

The old Railway live-asset carry and voice-model download stages were removed.
Builds no longer contact a deployed app or fetch a speech model. Optional offline
speech models must already exist as reviewed public assets; the recognizer worker
still builds locally. Without a bundled model, offline voice commands retain
their existing unavailable-model behavior. Older tabs may need to reload when
a revision removes their chunks; no cross-revision asset retention is claimed.
Production font/dependency downloads remain build-environment concerns for GCP
Admin; local validation uses the existing offline font response hook.

## Environment and PACS settings

[ENV_SCHEMA.md](ENV_SCHEMA.md) and `lib/envSchema.ts` are the single contract.
The existing PACS settings on this branch are `DICOMWEB_BACKEND` plus
`HEALTHCARE_PROJECT`, `HEALTHCARE_LOCATION`, `HEALTHCARE_DATASET` and
`HEALTHCARE_DICOM_STORE`. They select the already-implemented Healthcare
DICOMweb adapter; no alternate endpoint variable or PACS alias was introduced.
Local Orthanc uses the existing optional `ORTHANC_*` settings. Desktop DIMSE
nodes are local desktop configuration, not Cloud Run environment variables.

The one provisional plain name remains **GCS_OBJECT_BUCKET**. GCP Admin must
confirm the name, private bucket and attached service-account access before
cutover. No real bucket name is invented. Public `BETTER_AUTH_URL` is required
before first boot; it can no longer be derived after a failing revision starts.
Production does not require or set `R2_*`, `ORTHANC_*`, `NEXT_PUBLIC_APP_URL`,
access-token overrides or credential-file paths.

## GCP Admin procedure after a separate authorization

These are handoff steps, not executed commands. All deployment identifiers below
are placeholders; the established resource shape is documented in ENV_SCHEMA.md.

1. Confirm the held integrations are disconnected, approve the exact reviewed
   commit and run the orchestrator's local/no-Actions gate. A merge does not deploy.
2. Confirm the private object bucket and the attached runtime service account's
   GCS/Healthcare permissions. Preserve the existing networking and Mongo policy.
   No credentials file or S3 HMAC key is needed: server-side runtime ADC only.
3. Build the existing Dockerfile into `<REGION>-docker.pkg.dev/<PROJECT>/<REPO>/app:<COMMIT>`.
   Existing `deploy/gcp/cloudbuild.yaml` / `deploy-app.sh` describe building and
   publishing for Admin use. Do not add secrets to build inputs. This agent does
   not run those files, build remotely, publish an image or deploy.
4. Configure the full ENV_SCHEMA plain-variable set before boot, including the
   confirmed bucket name and public HTTPS origin. Bind secret **names** to their
   Secret Manager versions: `BETTER_AUTH_SECRET`, `MONGODB_URI`,
   `TRUSTED_PROXY_SECRET`, plus enabled provider/OAuth secrets. Existing deployment
   helpers preserve unmentioned settings; they do not provision/guess the
   provisional shared bucket setting. A fresh service needs its complete env
   configured by Admin, not a bootstrap with missing mandatory variables.
5. Use the existing Cloud Run definition with `<SERVICE_ACCOUNT>`, container
   port 8080 and startup probe `/api/healthz`. Keep traffic cutover as a separate
   Admin decision after the candidate revision starts and authenticated synthetic
   checks pass. Liveness alone does not verify storage/IAM/provider contracts.
6. Only after that authorization, point the Worker at `<CLOUD_RUN_ORIGIN>` and
   configure its shared secret separately. Preserve C1's authenticated forwarded
   host contract; no client-supplied host/secret is trusted.

Desktop updater defaults now use the stable public `learn.flowrad.ai` front door
instead of a Railway service URL. GitHub release fallback and signing keys are
unchanged; no desktop release or update request was made. Legacy Fly files and
Railway incident reports are historical references, not current deploy targets.

## Local verification boundary

Docker is **not installed** (`command -v docker` found no executable), so
`docker build` was **NOT EXECUTED**. Static tests verify stages, source allowlist,
non-root user, port, startup command, absence of secret args, context exclusions,
removed Railway config and health probes. The compiled runtime validator runs
in real local Node child processes with synthetic env values; health and app
behavior run in unit/Playwright suites. Container startup/image layers and
native desktop updater execution are not claimed verified.

**NO LIVE GCP CALL WAS MADE.** No GCP or Railway service was contacted or changed.
Gemini remains mocked: **live contract not verified**. See the Step B validation
record and status file for exact commands/results. Capture/replay T1–T10 and
deferred P0 work are unchanged; this step is deployment preparation only.
