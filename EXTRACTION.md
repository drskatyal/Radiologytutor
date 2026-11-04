# FlowRad Viewer: extracted from Radiologytutor

This tree is the FlowRad Viewer (web viewer, viewer core, and the Windows and macOS
desktop viewer), copied out of `drskatyal/Radiologytutor` with its history.

- **Source:** `drskatyal/Radiologytutor`, branch `claude/epic-noether-3nvcbf`, commit `b0b3204`
  ("Merge pull request #155 … web-sr-ko-2").
- **Method:** `git filter-repo --paths-from-file EXTRACTED_PATHS.txt` on a fresh clone.
  Radiologytutor itself was not changed. Commit SHAs differ from the source because
  history was rewritten. The messages, authors and dates are the same.
- **History:** 349 commits that touch the kept paths. Commits that touched none of them
  were dropped.

## What was kept

The path list is the import closure of these roots, with tests, build config, CI and docs
added for each kept module:

| Root | What it is |
| --- | --- |
| `app/viewer/**` | Free web viewer (`/viewer`, `/viewer/local`), no sign-in |
| `app/api/dicomweb/[...path]` | Same-origin DICOMweb proxy (Orthanc or Cloud Healthcare) |
| `packages/viewer-core/` | `@flowrad/viewer-core`, the standalone viewer core |
| `desktop/` | FlowRad Viewer desktop app (Tauri 2: Windows, macOS, Linux) |
| `components/viewer`, `components/ui`, `lib/viewer*`, … | What those roots import |
| `.github/workflows/desktop-*.yml`, `web-ci.yml` | Desktop CI/release and web CI |
| `deploy/gcp/`, `docs/GCP_CLOUD_RUN.md` | Cloud Run deploy (reused for viewer.flowrad.ai) |

Some RadLearn modules (`lib/cases.ts`, `lib/auth.ts`, `lib/mongo.ts`, `lib/teachingGuide.ts`,
…) are still here only because the kept proxy and layout import them. The feature branch
removes them as the viewer gets its own account and store seams.

## Verified on this tree (before any feature work)

- `npm ci && npm run build`: passes (routes: `/viewer`, `/viewer/local`, `/api/dicomweb/*`).
- `npm test`: 568 tests, 567 pass, 0 fail.
- `npm ci --prefix desktop && npm run build --prefix desktop` (type check + Vite renderer): passes.
  The Rust/Tauri bundles are built by `.github/workflows/desktop-release.yml`; they were not built here.
