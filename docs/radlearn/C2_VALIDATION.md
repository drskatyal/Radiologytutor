# C2 validation — 12 November 2026

Implementation: `75018b6` — private GCS storage, shared runtime ADC and the
existing Healthcare/Orthanc adapter. See ENV_SCHEMA.md for the environment
contract and the provisional bucket name needing GCP Admin confirmation.

| Local check | Final result | Evidence |
| --- | --- | --- |
| `npm test` | 1,182 total; 1,180 passed, 0 failed, 2 existing skips | evidence/c2-test.log |
| `npx tsc --noEmit` | Exit 2; 279 baseline diagnostics, 0 new / 0 removed after line/column and union-order normalization | evidence/c2-tsc.log, evidence/c2-tsc-comparison.log |
| `npm run build` with offline fonts | Exit 0; compile/type validation and 40 static pages passed | evidence/c2-build.log |
| Archive Playwright | 11 passed, 0 failed; case-viewer (6), student-session (5) | evidence/c2-archive.log |
| RadLearn Playwright | 8 passed, 0 failed; approval (1), dicomweb-auth (1), exam-leak (1), synthetic (1), trusted-host (4) | evidence/c2-radlearn.log |
| `bash -n deploy/gcp/deploy-app.sh deploy/gcp/setup.sh` | Exit 0; syntax only, scripts not executed | Local command |
| `git diff --check` | Exit 0 | Local command |

Exact final suite commands:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-c2-test-verified.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-c2-build-final.log 2>&1
npx tsc --noEmit > radlearn-c2-tsc-final.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-c2-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts > radlearn-c2-radlearn.log 2>&1
```

Initial development checks are not claimed as passes. The first focused run had
10 passes / 1 failure: the new bundle assertion used the wrong field shape.
The first full suite had 1,178 passes / 1 failure / 2 skips for the same new
assertion; it now checks `stats.frames` and exact `index.sops`. An intermediate
full run passed 1,179 with 2 skips, before the final deployment-source test was
added. The first production build failed on the test HTTP fixture's Buffer
body type; explicit Uint8Array bodies fixed it. An intermediate standalone tsc
had five new ProcessEnv test-argument diagnostics; the pure config readers now
accept readonly string maps. No existing test was edited or weakened. Initial
focused/build failure outputs are retained in evidence/c2-*-initial.log.

**NO LIVE GCP CALL WAS MADE.** GCS HTTP, Healthcare QIDO/WADO/STOW/metadata and
Google token acquisition are mocked. The real local implementations run for
de-identification, UID remapping, bundle encoding, allowlisted JSON, object
serialization, proxy authorization and the Next/Cornerstone browser UI. Fixtures
are synthetic. No actual credential files, remote studies, databases, buckets,
IAM resources or deployments were accessed. Gemini: **live contract not verified**.

Only the approved Google auth dependency was added (pinned 11.3.4). Existing GCS
JSON API code was reused; no storage SDK was needed. Production deploy examples
were edited locally to remove R2/HMAC wiring and reflect the existing 3.8 TTS
default. No deployment commands were executed. Other Playwright configurations,
live cloud contracts and optional desktop suites: **NOT EXECUTED for C2**; the
requested archive/RadLearn configs and every new C2 spec were executed.

No local implementation blocker remains. Cutover still needs GCP Admin to
confirm `GCS_OBJECT_BUCKET`, the private bucket and the attached service-account
access. This was explicitly permitted as a provisional name; it is not a claim
that production is configured. PRs/merges/deployments remain held. No push.
