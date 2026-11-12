# Step B validation — Cloud Run files only

Implementation: `22e585e`. The Dockerfile, production preload, health route and
existing GCP deployment references are prepared locally. Railway config is
removed; external integration disconnection remains unverified and held.

| Local check | Final result | Evidence |
| --- | --- | --- |
| `npm test` | 1,191 total: 1,189 passed, 0 failed, 2 existing skips; 9 new Step B tests | evidence/b-test.log |
| `npx tsc --noEmit` | Exit 2; 279 baseline diagnostics, 0 new / removed after source-position and union-order normalization | evidence/b-tsc.log, evidence/b-tsc-comparison.log |
| `npm run build` with offline fonts | Passed, exit 0; compile/type validation, 40 static pages and production-preload compilation | evidence/b-build.log |
| Archive Playwright | 11 passed / 0 failed: case-viewer (6), student-session (5) | evidence/b-archive.log |
| RadLearn Playwright | 9 passed / 0 failed: approval (1), dicomweb-auth (1), exam-leak (1), healthz (1), synthetic (1), trusted-host (4) | evidence/b-radlearn.log |
| `bash -n deploy/gcp/deploy-app.sh` | Passed; syntax only, not script execution | Local command |
| `git diff --check` | Passed | Local command |
| Docker | **NOT EXECUTED:** no docker executable; static checks only | command lookup and unit suite |

Exact final commands:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-b-test-verified.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-b-build.log 2>&1
npx tsc --noEmit > radlearn-b-tsc-verified.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-b-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts > radlearn-b-radlearn.log 2>&1
command -v docker || true
node --version
bash -n deploy/gcp/deploy-app.sh
git diff --check
```

Docker lookup produced no executable. Node was 24.22.1; all Docker stages now
target Node 24. Image tags/layers were not downloaded or inspected. Static tests
verify production build, source allowlist, private-context exclusions, non-root
runtime, 8080/default PORT behavior, checked startup entry and health probes.
Tests also execute the compiled preload in real local Node child processes:
missing/malformed env exits before server code, messages omit values, valid
synthetic settings allow continuation, and custom PORT is preserved.

Initial focused tests: 8/8 passed, before the desktop endpoint static test was
added. Initial/full and intermediate suites also passed 1,189 with 2 skips.
Initial standalone TypeScript had 280 diagnostics: the new subprocess fixture's
env map did not declare Next's required NODE_ENV property. The fixture now
provides it explicitly; final checks return to 279 with no new diagnostics.
No existing tests were edited or weakened. The final assertion-only Docker
major-version check does not change the production application bundle.

Real: production Next build, compiled Node validator processes, constant health
handler, local Next/Cornerstone browser behavior and existing application tests.
Mocked: synthetic archive/pixels, Google/GCS/DICOM transport, provider calls and
Google font responses. **NO LIVE GCP CALL WAS MADE.** Gemini **live contract not
verified**. No production values, credentials, real patient data or remote
services were accessed. No deploy/provision scripts, Docker push, GitHub Actions,
push, PR or merge ran. Existing pure deployment-env resolver unit tests still run
locally as part of npm test; they do not call deployment commands or services.

Other Playwright configs, native desktop runtime and container execution:
**NOT EXECUTED for Step B**. Requested configs and every new browser spec ran.
Desktop update origins were checked statically; the signing key and GitHub
release fallback were unchanged and no update request was made.

No local implementation blocker remains. The explicitly allowed static Docker
fallback is used. No separate Step A web-PACS env schema exists in this checkout,
so existing C2 Healthcare/Orthanc names were documented without aliases. The
provisional GCS bucket name/access and external integration disconnection still
need GCP Admin/orchestrator confirmation before any cutover. Optional offline
voice models and cross-revision static asset retention are not downloaded or
claimed by this image build. All capture/replay milestone holds remain intact.
