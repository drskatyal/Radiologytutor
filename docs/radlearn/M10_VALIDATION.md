# M10 validation — 12 November 2026

M10 implements report, rendered-point and held-voice answers, recorded hints/retries
and assistance, deterministic server grading, owned attempt resumption, and explicit
post-close reference reveal. Details and isolation boundaries are in
[EXAMINER.md](EXAMINER.md). No later milestone is started.

## Commands

All commands ran in `/workspace/radlearn-build` on
`codex/radlearn-strategy-build`, using the existing dependency installation and the
existing Chromium binary. Browser configs ran sequentially on localhost only.

```sh
TMPDIR="$PWD/.radlearn-tmp" npm test
npx tsc --noEmit
python3 .radlearn-tmp/m10-compare-tsc.py
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.exam.config.ts --workers=1
```

## Results

| Check | Final result |
| --- | --- |
| `npm test` | 1,319 total; 1,317 passed, zero failed, two existing skips |
| `npx tsc --noEmit` | 279 baseline diagnostics; zero new, zero removed (exit 2) |
| Production build | Passed; 40 static pages |
| RadLearn Playwright | 38 passed / zero failed / zero skipped |
| Archive Playwright | 11 passed / zero failed / zero skipped |
| Exam provider-mock Playwright | 2 passed / zero failed / zero skipped |

Every spec in the three requested configs was executed. The complete RadLearn run
also measured synthetic replay beep drift of 5.33 ms and 6 ms (limit 100 ms).

The two unit skips are existing platform/fixture limitations, not M10 tests.
Standalone TypeScript exits 2 with the same 279 baseline diagnostics; it is not
reported as a passing standalone compile. Comparison normalizes source positions
and ordering of string-literal union members only. Next's production build and
its type validation pass. Full local outputs are retained in `evidence/m10-*`.

## Development checks and corrections

- Initial focused exam units: 15 passed. The added reproducibility case brings the
  final focused exam set to 16 tests, included in the full unit suite.
- Initial full development units: 1,319 total / 1,317 passed / zero failed / two
  existing skips. Development builds passed.
- An intermediate TypeScript check identified two new missing `view` properties
  on the metadata lookup anchor. Fixed by passing the required empty view; the
  final diagnostic comparison matches the baseline exactly.
- First mocked-provider exam browser run: zero passed / two failed. One new test
  used an ambiguous status selector (viewer and exam both announce status). The
  other found that a rejected PHI-review flag surfaced as a generic 503. The new
  test selector now scopes the exam message and the endpoint returns a clear 422.
  No pre-existing assertion or spec was weakened. The next focused run passed
  both tests. Final provider coverage also rejects synthetic PHI in a returned
  transcript and deliberately omits valid clauses from the mock model response,
  demonstrating that the deterministic score is independent of model omissions.

## Real versus mocked and scope

Real: local authentication and owned persistence, immutable key snapshots, atomic
revision checks, deterministic grading, existing DICOM decoder/render events,
image-pixel capture, browser MediaRecorder with fake microphone input, and production
API routes/adapters. Mocked: local synthetic DICOM HTTP archive, all STT/TTS/model
provider responses, and offline build fonts. The normal radlearn suite mocks the
exam audio responses; the dedicated exam config runs real server audio routes with
a fail-closed provider transport mock and audits the model request bodies.

No new dependencies, production data, grandfathering, cloud service changes, deploys,
PRs, merges, pushes or Actions runs. GCP remains the only deploy target; all holds
remain. `GCS_OBJECT_BUCKET` and its single schema definition are unchanged.
**NOT VERIFIED LIVE; live contract not verified. NO LIVE GCP CALL WAS MADE.**
No strategy deviation or implementation blocker. The read-only pre-push gate and
commit identifiers are recorded in `/workspace/radlearn-build-status.md`.
