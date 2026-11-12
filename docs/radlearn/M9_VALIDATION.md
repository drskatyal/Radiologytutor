# M9 local validation — 12 Nov 2026

Scope: strategy §4 M9, P0-8 caller execution and the tutor-boundary parts of the
acceptance mapping. M10 is not started. Starting point is M8
`ea3272c0a641f9dd8d72cab5465a090d7d7fe13a`: 1,294 passing unit tests, two existing
skips, 279 baseline TypeScript diagnostics, archive 11/11 and RadLearn 30/30.

Implementation commits:

- `24d8424`: typed commands, current-approval resolution, held capture and
  cancellable render/speech orchestration; 16 new unit tests.
- `35c1576`: dedicated correction of the old fullscreen microphone name
  assertion, with its reason and strategy link in M9_TEST_CHANGES.md.
- `ba5d643`: authenticated command route, separate held STT/tutor calls, primary
  viewer acknowledgement, held controls, cancellation and six browser tests.

The complete working-tree unit suite and production build passed at these
commit checkpoints. The documentation/evidence commit follows separately.

| Check | Result |
|---|---|
| npm test | 1,312 total: 1,310 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2; 279 baseline diagnostics, 0 new, 0 removed |
| npm run build, offline fonts | PASS; 40 static pages and runtime environment preload |
| Playwright archive, full config | 11 passed, 0 failed |
| Playwright RadLearn, full config | 36 passed, 0 failed |
| Focused M9 browser acceptance | 6 passed, 0 failed |
| git diff --check | PASS |

The existing skips are local Mongo integration (no mongod; remote Mongo is
forbidden) and the existing SR/KO fixture. TypeScript comparison normalizes
source positions and string-literal union ordering only against
`evidence/final-tsc.log`; no diagnostic is filtered.

Exact final commands from `/workspace/radlearn-build`:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-m9-final-test.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-m9-final-build.log 2>&1
npx tsc --noEmit > radlearn-m9-final-tsc.log 2>&1
python3 .radlearn-tmp/m9-compare-tsc.py > radlearn-m9-tsc-comparison.log
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-m9-final-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-m9-final-radlearn.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts tutor-loop.spec.ts --workers=1 > radlearn-m9-focused-radlearn.log 2>&1
```

The archive and RadLearn configurations ran sequentially on localhost, sharing
ports 3102/3199. No browser download or dependency was added.

Development results, not counted as final passes:

- Initial core unit checkpoint: 11/11. Adding planner/annotation tests exposed
  an undefined legacy `panX`/`panY` property incorrectly treated as coordinates
  (12 passed, 1 failed); the adapter now rejects supplied numeric coordinates
  while accepting absent fields. The expanded final suite includes strict raw
  scalar validation, full action retention and foreign-series rejection.
- A development build caught a deleted import used by an old hung-narration
  auto-advance effect. That obsolete effect was removed: the acknowledged queue
  stops on failure instead of advancing after an interrupted utterance.
- First focused browser checkpoint: 3/3. First full RadLearn run: 35 passed,
  1 failed. The new API test left an exam attempt open in its reused synthetic
  session; the next test's catalog request correctly returned 403. The test now
  completes the attempt and explicitly checks catalog status. No production
  behavior or existing assertion was relaxed. The focused six-test rerun passed.
  `evidence/m9-initial-radlearn.log` retains the failed run.
- The next full run passed all six M9 tests but timed out in the existing T4
  capture test waiting for its first audio upload receipt (35 passed, 1 failed).
  Its unchanged focused recheck passed 2/2. The affected journal/TrackRecorder
  path is unchanged by M9; the timeout's underlying cause was not established.
  The final full rerun also passed T4 unchanged. No deadline/assertion was relaxed. `evidence/m9-capture-timeout.log` retains
  this failed run and `m9-capture-recheck.log` records the unchanged recheck.


Real: browser MediaRecorder using the configured fake device, local synthetic
DICOM rendering, exact snapshot acknowledgements, authenticated/org-scoped
Next routes, current approvals, version invalidation, real HTML audio playback
and cancellation, manual viewer scrolling and keyboard/pointer controls.
Mocked: STT/tutor/TTS responses, synthetic CT and beep audio, localhost DICOM
archive, unit provider/cloud transports and offline fonts. The browser spy
observes real `audio.play`; delayed frames never forge IMAGE_RENDERED.

**live contract not verified. NO LIVE GCP CALL WAS MADE.**

Implementation choices: REST STT followed by a separate plan is the default;
no persistent Live session is opened. The obsolete unacknowledged guide/model
sketch path was replaced with the approved command queue. Unsupported plans fail
as a whole. The planned `queue.test.ts` is `orchestrator.test.ts`, matching the
strategy's module name. The microphone-name correction is its own commit.
No other strategy deviation, new environment name, dependency or data migration.

No push, PR, merge, deployment, credential access, patient data, remote service
script or `.github` modification. GCP remains the only deployment target, the
orchestrator's PR/merge holds remain, and no-grandfathering remains in force.
The final full rerun passed all 36 specs unchanged, including T4. No blocker; the final gate output is recorded in
`/workspace/radlearn-build-status.md` after all commits.


Final per-spec results (all zero failures; none omitted):

| Config / spec | Passed |
|---|---|
| archive / case-viewer.spec.ts | 6 |
| archive / student-session.spec.ts | 5 |
| radlearn / anchor-incomplete.spec.ts | 1 |
| radlearn / anchor-order.spec.ts | 1 |
| radlearn / approval.spec.ts | 2 |
| radlearn / approved-tools.spec.ts | 2 |
| radlearn / capture-recovery.spec.ts | 2 |
| radlearn / dicomweb-auth.spec.ts | 1 |
| radlearn / exam-leak.spec.ts | 1 |
| radlearn / extraction.spec.ts | 1 |
| radlearn / healthz.spec.ts | 1 |
| radlearn / markers.spec.ts | 1 |
| radlearn / mic-retry.spec.ts | 1 |
| radlearn / render-ack.spec.ts | 1 |
| radlearn / replay-clock.spec.ts | 2 |
| radlearn / replay-delay.spec.ts | 1 |
| radlearn / replay-first-frame.spec.ts | 2 |
| radlearn / replay-geometry.spec.ts | 1 |
| radlearn / replay-missing-instance.spec.ts | 2 |
| radlearn / replay.spec.ts | 1 |
| radlearn / review-jump.spec.ts | 1 |
| radlearn / synthetic.spec.ts | 1 |
| radlearn / trusted-host.spec.ts | 4 |
| radlearn / tutor-loop.spec.ts | 6 |

M8 audio regression measured beep drift of 5.33 ms, 6.00 ms (limit ≤100 ms).

Compatibility boundary: the default tutor no longer executes legacy timed guide
check-ins or unacknowledged authored sketch actions. Guided teaching uses the
approved model command queue; no replacement examiner/scoring workflow is built
in M9. Existing author QA replay and isolation checks remain green.
