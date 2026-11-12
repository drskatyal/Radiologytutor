# P0-4 local validation — 12 November 2026

Implementation commit: `6afcf93` on `codex/radlearn-strategy-build`.
The complete approved-tool contract is in APPROVED_TOOLS.md and the acceptance
mapping is updated. This step implements no other M9 feature.

| Check | Final result |
|---|---|
| npm test | 1,214 total; 1,212 passed, 0 failed, 2 existing skips. 23 added tests. |
| npx tsc --noEmit | Exit 2: 279 baseline diagnostics, 0 added/removed after source-position and union-order normalization. |
| npm run build | Passed; 40/40 static pages and runtime env postbuild completed. |
| Archive Playwright | 11 passed, 0 failed/skipped: case-viewer 6, student-session 5. |
| RadLearn Playwright | 11 passed, 0 failed/skipped: approval 1, approved-tools 2, dicomweb-auth 1, exam-leak 1, healthz 1, synthetic 1, trusted-host 4. |
| git diff --check | Passed. No .github or env-schema changes. |

Commands (from `/workspace/radlearn-build`; no downloads):

```sh
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-p04-test.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-p04-build.log 2>&1
npx tsc --noEmit > radlearn-p04-tsc.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-p04-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-p04-radlearn.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" npx tsx --tsconfig tsconfig.test.json --test lib/harness/approvedTools.test.ts > radlearn-p04-focused.log 2>&1
git diff --check
```

Final full outputs: `evidence/p04-{test,tsc,build,archive,radlearn}.log` and
`evidence/p04-tsc-comparison.log`. Focused tests were run during development;
all of them are included in the final npm suite. The planning request snapshot
was regenerated locally with a synthetic fetch stub; no model call was made.

Development failures resolved without weakening tests: the first build found
an optional Cornerstone method invocation, fixed with a fail-closed optional
getter. The first RadLearn run had 10 passes/1 failure because finding creation
discarded named annotations; the route now retains that versioned field and the
same positive annotation assertion passes. Subsequent full runs are green.

NOT EXECUTED: the default LIDC Playwright config and visual config, which are
outside this step's archive/RadLearn scope. No browser download, LIDC download,
remote dataset, deployment, remote script, push, PR, merge or Actions run.
No new dependency. GCS_OBJECT_BUCKET remains the one existing provisional
constant, pending GCP Admin confirmation.

Real: pure parser, approval/hash/inventory checks, pixel projection integration,
loaded identity resolver, authenticated Next routes, local synthetic JSON store,
Cornerstone browser rendering, production build. Mocked: Gemini and cloud HTTP;
localhost synthetic DICOM archive and offline font response. **live contract not
verified. NO LIVE GCP CALL WAS MADE.** No live voice, no exact-render/speech-ack
claim. Existing viewport-space geometry migration remains M5/M8.

Defaults/holds: no grandfathering, GCP Cloud Run via GCP Admin only, PRs and
merges held pending the orchestrator's Railway-disconnection gate. No blocker.
The final read-only strategy §0.1 gate output and both commit SHAs are appended
to `/workspace/radlearn-build-status.md` after the evidence commit; no push.
