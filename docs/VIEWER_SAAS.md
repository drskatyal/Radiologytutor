# viewer.flowrad.ai: architecture and decisions

One site with three parts:

1. **Free web viewer** (`/viewer`). No login. Drop a folder, ZIP or files and read them on
   the device. Nothing is uploaded.
2. **Desktop downloads**: "Coming soon" with a waitlist link, until the builds are signed and
   self-updating (see `docs/DESKTOP_RELEASE_READINESS.md`). `/download/windows` and
   `/download/macos` are wired, so real links drop in with a single switch.
3. **Store and share** (after sign-in). Anonymise in the browser, then store, write up, collect,
   share, embed and download. This is a Pacsbin-style feature set.

Status: built and tested locally. It is **not deployed**. Deploying needs the GCP project, its
credentials and the domain (see the end of this file).

## Routes

| Route | Who | What |
| --- | --- | --- |
| `/` | public | Marketing home (merged from `flowrad-viewer-site`), download cards |
| `/pricing` | public | Plans by stored-study count |
| `/viewer` | public | Free local viewer (unchanged engine) |
| `/download/<platform>` | public | Back to the "coming soon" section today. 302 to the installer once `DESKTOP_DOWNLOADS_LIVE=1` and the manifest entry is signed |
| `/desktop/link` | owner | Confirm a desktop app's sign-in code (device link) |
| `/api/desktop/update`, `/config`, `/entitlement`, `/link` | desktop app | Update channel (204 until rollout), remote config, plan check (advisory), device sign-in |
| `/sign-in` | public | Identity Platform: Google or email link; dev sign-in locally |
| `/library` | owner | Stored studies, search, tag filter, **Store studies** (upload) |
| `/studies/<id>` | owner | Viewer + history / findings / diagnosis / tags, markup, share, collections, download, delete |
| `/collections`, `/collections/<id>` | owner | Ordered sets of studies, shareable as one link |
| `/links` | owner | Every share link, with status and revoke |
| `/account` | owner | Plan, usage, privacy notes |
| `/s/<token>` | anyone with the link | View-only study or collection |
| `/embed/<token>` | any site (iframe) | Same, without chrome; the only frameable route |

## Data flow for a stored study

```
reader's browser                                   server (Cloud Run)                     Google Cloud
────────────────                                   ──────────────────                     ────────────
pick folder → read headers (dicom-parser)
group studies/series (lib/cloud/uploadPlan)
untick SR/DOC/OT by default, confirm pixels checked
POST /api/studies {remapped UIDs, counts}  ──────▶ quota check (lib/cloud/plans) ─────────▶ Firestore: viewer_studies
for each file:
  anonymizeInstance(bytes, accountSalt)
  (lib/cloud/anonymize: PS3.15-style scrub,
   2.25 UIDs from SHA-256(salt, uid))
  POST /api/studies/<id>/instances  ──────────────▶ identity gate again (lib/deid +
                                                    lib/cloud/ingestGate): refuse residual
                                                    PHI, missing marker, wrong study
                                                    STOW-RS (lib/cloud/archive) ─────────────▶ Healthcare DICOM store
POST /api/studies/<id>/complete  ───────────────▶ QIDO counts → status "ready"
```

Original files, names and UIDs never leave the device. The server only sees anonymised bytes,
and it checks them again before storing anything.

**Not done automatically: burned-in text in pixels.** The upload dialog says so. The reader must
tick "I have checked these images". Series that often carry text (SR, DOC, OT, PR, KO) start
unticked. Pixel OCR is the next de-identification step (see "Next").

## Sharing and access

- A share is `{token, target: study | collection, mode: unknown | findings, expiresAt, revokedAt, allowDownload}`
  (`lib/cloud/shares.ts`). The token is 24 random bytes in base64url and is the whole grant.
- **Unknown** shows the images and the clinical history only. Findings, diagnosis, tags, markup
  and the study title are hidden; a collection shows "Case 1, 2, …". **With findings** shows everything.
- **Expiry** can be 1 day, 7 days, 30 days or never. **Revoke** is permanent. Both are checked on
  every DICOMweb read (`lib/cloud/access.ts`, memoised 15 s per instance, so a revoke takes effect
  within about 15 s).
- Pixels for shares go through `/api/dicomweb/s/<token>/studies/<uid>/…`. The token is in the
  path, not a cookie, so embeds work inside third-party iframes that block cookies. The proxy
  refuses any study the token does not grant and any archive-wide search.
- The owner reads through `/api/dicomweb/studies/<uid>/…` with the session cookie, limited to
  their own study UIDs.
- Framing: every route sends `frame-ancestors 'none'` except `/embed/*`. Share and embed pages
  are `noindex`, and embeds send `Referrer-Policy: no-referrer`, so the token does not leak.
- Downloads: `/api/studies/<id>/download` (owner) and `/api/s/<token>/download` (only when the
  link allows it). Both stream a ZIP built one instance at a time (`lib/cloud/zipWriter.ts`).

## Plans

`lib/cloud/plans.ts`: **Free 20, Pro 500, Super 2,000** stored studies. Prices are placeholders
($0 / $12 / $29). The site labels them as placeholders, and nothing takes payment. The quota is
enforced when a study is created (HTTP 402 with a plain message). Moving an account to Pro or
Super is a manual `plan` change on its Firestore document until billing exists.

## Teaching and quiz modes (later)

The data is ready for them: per-study history, findings, diagnosis, tags, saved markup on its
slices, and ordered collections. The study page says these modes are planned. Nothing pretends
to run them.

## Why Google Cloud (and not R2 or RadCrate)

| Need | Choice | Why |
| --- | --- | --- |
| Stored studies | **Cloud Healthcare API DICOM store** | Real DICOMweb (STOW, WADO, QIDO), so the viewer reads it with no new code (the proxy already supports `DICOMWEB_BACKEND=healthcare`). It is managed, has a BAA available, and is regional. Cloudflare R2 is object storage: we would have to write our own WADO and QIDO layer, and we would lose the DICOM-aware de-id and search. |
| Metadata | **Firestore (Native)** | Serverless and per-document. It fits small owner-scoped rows. We call it over REST with the Cloud Run metadata token from `lib/gcpAuth.ts`, so we add no SDK and no second auth path. |
| Sign-in | **Identity Platform** | Google and email-link sign-in with no passwords stored by us. The server verifies ID tokens itself (`lib/cloud/session.ts`). |
| Installers | **GCS bucket, public objects** | Release artifacts are in a private repo's draft releases, which the public cannot download. A GCS bucket written by the release workflow (keyless, Workload Identity Federation) gives stable public URLs. |
| Hosting | **Cloud Run** | The existing standalone image (`Dockerfile`), scale to zero, and the same region as the DICOM store. |
| Frame cache | GCS, optional | `lib/frameCache.ts` already speaks S3-compatible HMAC, which GCS supports. |

**RadCrate** is a radiology resources site in the FlowRad product family, not a storage
service. It has no part to play in the storage path. R2's main advantage is no egress fees, and
that only matters once share traffic is heavy. If it does, the change is to put Cloud CDN (or R2)
in front of the frame cache. The DICOM store would stay as the source.

## Site merge: merged, not linked

`drskatyal/flowrad-viewer-site` was a static page that described a viewer which didn't exist yet,
with waitlist buttons. **It is merged here** (`app/(site)`):

- The home page needs live data: whether an installer is published (from the downloads manifest)
  and whether the visitor is signed in. A static site would need JavaScript fetches across
  origins for both.
- One deploy, one domain (`viewer.flowrad.ai`), no CORS, and no drift between the marketing copy
  and what the app does.
- The brand rules come with it. The Owl Scan files are copied byte for byte into `public/brand`,
  the self-hosted Inter and Cormorant fonts into `public/fonts`, and the shared products menu and
  footer spec into `site/shared/` (`flowrad-nav.json` is unchanged and still pinned by
  `flowrad-nav.sha256`, so it stays identical to `flowrad-landing`).
  `site/render-flowrad-nav.py` renders it to `components/site/flowradNav.generated.ts`, and
  `--check` fails CI if they drift.
- The site's CSS is ported as-is, scoped under `.fr-site` so it cannot affect the app pages.

`flowrad-viewer-site` can be archived once this is deployed. Until then, the static site keeps
serving `viewer.flowrad.ai`.

## Configuration (environment)

| Variable | Where | Purpose |
| --- | --- | --- |
| `DICOMWEB_BACKEND=healthcare`, `HEALTHCARE_PROJECT`, `HEALTHCARE_LOCATION`, `HEALTHCARE_DATASET`, `HEALTHCARE_DICOM_STORE` | Cloud Run | Archive (dev: `ORTHANC_URL`) |
| `FIRESTORE_PROJECT` (+ `FIRESTORE_DATABASE`) | Cloud Run | Store. Unset means a memory or JSON-file store, which Cloud Run refuses. |
| `IDENTITY_PROJECT_ID`, `IDENTITY_API_KEY`, `IDENTITY_AUTH_DOMAIN` | Cloud Run | Sign-in (the API key is public by design; restrict it to the site's referrers) |
| `SESSION_SECRET` | Secret Manager | Session cookie HMAC key |
| `DOWNLOADS_MANIFEST_URL` | Cloud Run | `https://storage.googleapis.com/<bucket>/desktop/downloads.json` |
| `DESKTOP_DOWNLOADS_LIVE` | Cloud Run | Unset ("coming soon") until signed, self-updating builds ship; `1` shows the download links |
| `PUBLIC_ORIGIN` | Cloud Run | Canonical origin for metadata |
| `VIEWER_DEV_SIGN_IN=1`, `VIEWER_STORE_FILE` | local only | Email-only dev sign-in, and a JSON store (default `.data/viewer-store.json`) |

## Running it locally

```bash
npm ci
VIEWER_DEV_SIGN_IN=1 ORTHANC_URL=http://localhost:8042 ORTHANC_PASSWORD=... npm run dev
```

Without `ORTHANC_URL` or Healthcare set, everything except storing studies works. The upload
route answers 503 "Study storage is not configured".

## What needs Sanyam

1. **GCP project and billing.** Pick or create the project (for example `flowrad-viewer-prod`),
   then `terraform apply` in `deploy/gcp/terraform` with `terraform.tfvars` (start from the
   example). Then add the `SESSION_SECRET` version (`openssl rand -base64 48 | gcloud secrets versions add SESSION_SECRET --data-file=-`).
2. **Identity Platform.** Enable it in the console, turn on the Google provider and Email link,
   and add `viewer.flowrad.ai` to the authorised domains. Put the web API key in `identity_api_key`.
3. **Healthcare API BAA / data terms.** Even though only anonymised data is stored, confirm the
   project's terms before real use.
4. **Domain.** Verify `flowrad.ai` in the project, set `custom_domain = "viewer.flowrad.ai"`,
   create the DNS records from the `domain_dns_records` output, then retire the static site.
5. **Repository.** Create `drskatyal/flowrad-viewer` (private) and push this branch's history to
   it. This session could not create repositories, so the code currently lives on the
   `claude/flowrad-viewer-extract` branch of Radiologytutor.
6. **Desktop signing before any download link.** The updater private key secret, plus Apple and
   Windows code-signing. The full list and go-live order are in `docs/DESKTOP_RELEASE_READINESS.md`.
   Release uploads also need the repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER`,
   `GCP_RELEASE_SERVICE_ACCOUNT` and `GCS_DOWNLOADS_BUCKET` from the Terraform outputs.
7. **Prices.** Replace the placeholder prices and choose a billing provider (out of scope here).

## Plugins and the free core

The viewer has a plugin extension point (hook and loader only, no plugins, off by default). See
`docs/PLUGINS.md`. 3D MPR (multiplanar and 3D volume) is planned as **free core**, and
`FREE_CORE_FEATURES` keeps it out of any paid plan.

## Next

- Pixel OCR for burned-in text before upload (in the browser, behind the same confirm step).
- Upload from the viewer itself ("Store this study" after a drop) and from ZIPs.
- Teaching mode (step through the findings with markup) and quiz mode (unknown → reveal, click
  the finding) on the existing data.
- Billing and plan changes. Per-share view counts.
