# Product surfaces — RadLearn and ScrollRad / RadCrate

Decision date: 2026-10-27. Sources: Radiologytutor tip `claude/epic-noether-3nvcbf` (`257bd51`) and private repo `drskatyal/scrollrad` tip `claude/railway-mcp-deploy-jx81r0` (`24569ef`, 2026-09-22). `main` on scrollrad is behind that tip (`41c2d2d`, 2026-07-26).

This is a product decision, not a build plan. Do not merge the repositories on the back of this note.

## Recommendation

**B. Two products.** Do not merge ScrollRad into Radiologytutor, and do not merge the tutor into the PWA.

- **RadLearn** (this repo, brand FlowRad Learn) is the premium product: an AI attending and examiner on real DICOM, driven by `LiveTeachingPack`.
- **RadCrate** (repo still named `scrollrad`, user-facing name RadCrate) stays the light, privacy-first share PWA: record a scrolling scan, keep frames on the device, send a colleague a file or a short link.

One brand *family* is already how the PWA behaves (it links to `https://canvas.flowrad.ai` and can optionally share a Clerk instance). That is a cross-link, not one app and not one repo. A later shared login is fine. A merged codebase is not.

## What each product actually is

### RadLearn (this repository)

Teaching product. A teacher uploads real DICOM. The student opens `/case/[caseId]` and talks to a live tutor.

- **Teach me** and **Examiner** are two modes of one session. Flash compiles a `LiveTeachingPack` (findings, pearls, and viewer drive copied from saved anchors — the model does not place the slice). Gemini Live speaks and calls `set_series` / window / finding tools. ElevenLabs is the cloned voice when enrolled.
- **Viewer** is self-hosted Cornerstone3D. Pacsbin is gone. `lib/pacsbinUrl.ts` only parses legacy bookmarks. `pacsbinBaseUrl` is a legacy field.
- **Pixels** are DICOM, served through `/api/dicomweb` from Cloud Healthcare API in production (`radlearn-app`, `europe-west2`) or Orthanc in dev. Series identity is a UID. Window/level is the authored Hounsfield pair.
- **Library** (`/library`) is the published teaching catalog (cases, courses, playlists). It is not a personal locker and it does not mint share links. There is no share-token route on this tip.
- **Privacy** is server-side and header-scoped. `lib/deid.ts` strips identity tags on ingest and blocks publish without a passing `DeidReport`. Pixel OCR is explicitly not implemented and must not be claimed.
- **Auth** is Better Auth behind `lib/auth.ts`. Orgs and roles are real. Marketplace payments are deferred (`docs/DECISIONS.md`).
- **Cost** sits on Cloud Run, the DICOM store, Atlas, and per-session Gemini Live / ElevenLabs. That cost is the premium wedge. It is the wrong meter for a free WhatsApp loop.

The “Pacsbin-style case library with share links” is a requested second surface. It is not in the tree yet.

### ScrollRad / RadCrate

Curbside-consult product. A radiologist records a **video of a study being scrolled** (screen capture, camera, or file). The browser turns that video into a stack of JPEGs and can send it to a colleague who installs nothing.

Read the code, not the root `README.md`. The README still says “ScrollRad”, “PHI never leaves the phone”, and “auto-split into series”. The tip does not match that.

- **Brand in the UI** is RadCrate (`radcrate.com` in the rebrand commit). Repo, IndexedDB name (`scrollrad`), and root README still say ScrollRad.
- **Stack** is a static Vite + React 19 PWA (`app/`). Railway runs `serve` on the built files (`Dockerfile`, port 3000). There is no app server, no DICOM, no Gemini.
- **Pipeline** (`app/src/lib/pipeline/index.ts`): extract at about 10 fps, cap 480 samples, long edge 1024, JPEG 0.85 → conservative dedup → encode → **one series**. Auto-split was removed because it cut single studies apart. Manual split remains on the series-review screen. Optional stabilize / deflicker / sharpen, off by default.
- **PHI.** The user crops the workstation chrome before processing. `scrub.ts` (margin bands plus a brightness-based text detector, no Tesseract) is **not called** by the orchestrator. The pipeline still marks every case `scrubbed: true` and stores empty redaction lists. The landing page still says burned-in text is masked. Treat that claim as stale. Link sharing, when used, uploads the HTML.
- **Not DICOM.** Frames are 8-bit screen captures. Window/level is a LUT on already-windowed pixels. It cannot recover Hounsfield values, measurements, or a series UID. A comment in the July 23 windowing commit says this outright.
- **Library** is on-device IndexedDB: modality, region, findings, diagnosis, tags, a teaching star. Search is local. Nothing is a multi-tenant catalog.
- **Share.** Default is a self-contained HTML viewer (scroll, zoom, pan, 8-bit window, arrows) via the Web Share API, with the URL inside the message body so WhatsApp does not drop it. Optional Cloudflare Worker + R2 (`cloudflare/`) stores that HTML at `POST /api/share` and serves `GET /v/:id`. Ids are 10 unguessable characters, default expiry 30 days, 100 MB cap, optional `SHARE_KEY`. A link is a shared secret, not an access-controlled grant. Copy says “Not for primary diagnosis.”
- **Auth** is optional Clerk (`VITE_CLERK_PUBLISHABLE_KEY`). Sharing was briefly gated, then made free again so the loop stays viral. Login is reserved for a future synced library. `FLOWRAD_URL` is `https://canvas.flowrad.ai`.
- **Maturity.** The capture → viewer → share path is a real product, deployed as static files, with later PRs only for share-sheet overflow and zoom. Docs, the dead scrub module, and the “NO PHI” hero chip overclaim. `app-capture-processing/` is an old snapshot. `main` is not the tip.

## Comparison

| | RadCrate (`scrollrad`) | RadLearn (this repo) |
|---|---|---|
| Job | Curbside consult. “Don’t WhatsApp a video.” | Be taught a real study by voice, or sit a viva. |
| Input | Video of a scrolling workstation. | DICOM study (Healthcare API / Orthanc). |
| Pixels | 8-bit JPEG stack, ~1024 px, ≤480 frames. | Full DICOM. UID, slice index, HU window, measurements. |
| Viewer | Canvas scrubber, in-app and inside the shared HTML. | Cornerstone3D. Tutor drives it from a teaching pack. |
| Share | HTML file and/or short R2 link. Recipient needs no account. | No share links. `/library` is a published catalog. |
| Mobile | The product. PWA, touch scrub, WhatsApp. | Reading-room web app. Not a chat attachment. |
| Privacy | On-device until the user exports. PHI control is a manual crop. Auto-scrub code is unused. | Upload to our cloud. Header de-id gate. No pixel OCR. |
| AI | None. | Gemini Live + Flash pack + optional cloned voice. |
| Identity | Optional Clerk, aimed at a shared FlowRad instance. | Better Auth, org roles. Never trust a client `orgId`. |
| Cost | Static host + cents of R2 if links are on. | Cloud Run, DICOM store, Atlas, per-session model spend. |
| Brand | RadCrate in the UI. ScrollRad in the repo. Cyan scan accent. | FlowRad Learn. Film amber, editorial catalog, reading room. |

Overlap is the word “library” and the word “share”. The pixels, the promise, and the buyer are different. A resident WhatsApping a colleague a stack they cannot export from the hospital PACS is not the same person as a learner being walked through a de-identified teaching case.

## Why not one product (A)

Merging now would stall the tutor to rebuild a RadiScroll clone inside Next.js, or would stuff a DICOM platform into a static PWA that cannot host it.

- The teaching wedge needs Hounsfield windows, series UIDs, and authored drive anchors. A JPEG of a screen recording cannot supply them. `LiveTeachingPack` would be pretending.
- The privacy stories contradict. RadCrate’s value is “it stays on my phone until I choose a file.” RadLearn’s value is “we hold the study and teach from it.” One ingest path weakens both sentences.
- The meters contradict. A viral WhatsApp loop cannot sit on Gemini Live and a DICOM store. A teaching case cannot be a 15 MB base64 HTML file.
- Deploy targets contradict: Railway static files plus an optional Worker, versus Cloud Run plus Healthcare API. One repo would mean one broken deploy story.
- Names already collide. This repo’s `/library` is the course catalog. Calling the video app “the FlowRad library” would make the Pacsbin-style surface the front door. That is the opposite of the locked call: the tutor is the wedge; a case locker is a cheap tier.

If a merge is ever forced, **this repository is canonical**. Port the share *contract* only (unguessable id, expiry, the link written into the WhatsApp body, a “not for diagnosis” line), reimplemented for DICOM cases already in the archive. Do not port the Vite app, the JPEG pipeline, the canvas viewer, or `scrub.ts`. Archive `app-capture-processing/`. Leave RadCrate up until the DICOM share link actually replaces the curbside job — a video-of-scroll still matters when the workstation will not export DICOM.

## Why not one app with two modes yet (C)

C is the right *brand* picture later: FlowRad as the family, Teach as the paid room, Share as a cheap entry. It is the wrong *build* now. “Same app, two repos” means an iframe or a proxy, two viewers, and two auth systems (Better Auth here, optional Clerk there) glued in the nav. RadCrate already does the useful half of C with one outbound link. Finish the tutor. Add a DICOM share link here when the locker is actually specified. Do not stand up a second shell to imitate modes that are different products.

## How the RadLearn share library should relate to RadCrate

Build the requested locker **in this repo**, as a cheap tier, and leave the scrollrad repo alone.

- It shares **DICOM cases this app already stores**, opened in Cornerstone, behind an unguessable expiring link and a quota. Draft stays private. Publish still requires a passing header `DeidReport`. Do not claim burned-in PHI was scrubbed.
- It is a second entry (My cases / Send link), not the homepage and not a Pacsbin lookalike. The AI session remains the product on `/case/[caseId]`.
- Copy the RadCrate link *behavior* (short id, expiry, URL inside the message, no account for the recipient). Do not import RadCrate code, do not embed its viewer, and do not accept a video upload as a teaching case.
- Point RadCrate’s existing FlowRad link at the tutor. A single reverse line is enough, on the upload empty state: if the workstation cannot export DICOM, send a scroll from RadCrate. No shared database.
- Do not unify auth as part of the locker. Optional shared Clerk is a later identity project. Until then the products cross-link and keep their own sessions.

## Risks

**Merging now.** Two viewers, two pixel formats, and two PHI regimes in one deploy. Screen-capture frames that failed a manual crop would land in the same cloud as teaching DICOM. The tutor roadmap (live drive, measurements, de-id honesty) stops while the video pipeline is rewritten. Brand becomes FlowRad / RadLearn / Radiologytutor / ScrollRad / RadCrate in one nav.

**Staying split, done carelessly.** Two share buttons that sound the same. Avoid that by naming the jobs: “Send this DICOM case” here, “Send a scroll from a video” in RadCrate. A second risk is RadCrate’s own copy: the landing page and README still describe an automatic PHI mask and auto series-split that the pipeline no longer performs. Fix that in the scrollrad repo when someone next edits it. Do not “fix” it by folding the PWA into this app.

**Merging later.** Safe only for the share contract, and only after a DICOM link in this repo is good enough that maintaining a second viewer is the expensive choice. The video-capture path still will not become the tutor. Keep it as RadCrate, or drop it, but do not pour it into `LiveTeachingPack`.
