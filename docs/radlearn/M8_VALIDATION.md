# M8 local validation — 12 Nov 2026

Scope: strategy §4 M8 and mapped T3/T6/T8/T10 replay acceptance. M9 is not
started. No push, PR, merge, workflow, deployment, remote service/data access,
new dependency or environment name. Existing deployment/merge holds and
no-grandfathering decisions remain unchanged.

Implementation commits: `e549905` (journal player, audio, geometry, receipt
validation and unit tests) and `07a191b` (viewer/author integration, authenticated
route and browser acceptance). Both were checked with the complete working-tree
unit suite and production build. Documentation/evidence follow separately.

Starting point: M7 `c8ac2a36af06d651ff0217e9999c6bb9e9b85c52`, with 1,281
passing unit tests, two existing skips, 279 baseline TypeScript diagnostics,
a passing build, archive 11/11 and RadLearn 24/24.

| Check | Result |
|---|---|
| npm test | 1,296 tests: 1,294 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2; 279 baseline diagnostics, 0 new, 0 removed |
| npm run build, offline fonts | PASS; 40 static pages and runtime environment preload |
| Playwright RadLearn, full config | 30 passed, 0 failed |
| Playwright archive, full config | 11 passed, 0 failed |
| Focused replay evidence run | 4 passed, 0 failed |
| Synthetic beep drift | 5.33 ms and 6.00 ms (limit ≤100 ms) |
| git diff --check | PASS |

The existing skips remain local Mongo integration (no mongod; remote Mongo is
forbidden) and the pre-existing SR/KO fixture. All configured archive/RadLearn
specs completed in the successful full runs; none was omitted. TypeScript
comparison normalizes source positions and string-literal union ordering only,
against `evidence/final-tsc.log`. No diagnostic is filtered.

Exact final commands from `/workspace/radlearn-build`:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-m8-final-test.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-m8-final-build.log 2>&1
npx tsc --noEmit > radlearn-m8-final-tsc.log 2>&1
python3 .radlearn-tmp/m8-compare-tsc.py > radlearn-m8-tsc-comparison.log
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-m8-final-radlearn.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-m8-final-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts replay-clock.spec.ts replay-missing-instance.spec.ts --workers=1 > radlearn-m8-final-evidence.log 2>&1
```

The last focused run retains numeric beep-drift evidence and checks the missing
instance fixture's shared static import. No assertion or tolerance was relaxed.

Archive specs: `case-viewer.spec.ts` 6/6, `student-session.spec.ts` 5/5.
RadLearn specs (all zero failures in the full run):

| Spec | Passed |
|---|---|
| anchor-incomplete | 1 |
| anchor-order | 1 |
| approval | 2 |
| approved-tools | 2 |
| capture-recovery | 2 |
| dicomweb-auth | 1 |
| exam-leak | 1 |
| extraction | 1 |
| healthz | 1 |
| markers | 1 |
| mic-retry | 1 |
| render-ack | 1 |
| replay-clock (new) | 2 |
| replay-delay (new) | 1 |
| replay-first-frame | 2 |
| replay-geometry (new) | 1 |
| replay-missing-instance (extended) | 2 |
| replay (new end-to-end round trip) | 1 |
| review-jump | 1 |
| synthetic | 1 |
| trusted-host | 4 |

Development evidence, not counted as final passes:

- Core unit checkpoints: 8/8, then 12/12. Full unit checkpoints: 1,294 total /
  1,292 passed and 1,295 total / 1,293 passed, both with zero failures and two
  skips; the final audio-suspension test brings the count to 1,296.
- Initial TypeScript checks caught new fixture/closure typing errors, fixed
  locally. The final comparison has zero new diagnostics.
- First focused browser command used `replay.spec.ts replay-clock.spec.ts
  replay-geometry.spec.ts replay-delay.spec.ts replay-missing-instance.spec.ts`:
  6 passed, 1 failed because the new round-trip test expected “1 candidates”
  instead of the UI's singular “1 candidate”. Correcting that new assertion
  gave a focused `replay.spec.ts` run of 1/1, then the full 30/30.
- First archive process exited 143 after ten passes and before the last spec
  result. This was not counted as a complete pass; unchanged full rerun passed
  all 11. `m8-interrupted-archive.log` retains the incomplete output.
- Builds and full unit checks passed at the implementation commit checkpoints.
  No existing test assertion was removed or weakened.

Real: Cornerstone image rendering and full snapshot acknowledgement, Web Audio
sample playback/analyser observations, synthetic microphone MediaRecorder,
canvas capture, IndexedDB, local object checksums, authenticated Next routes,
organization scoping, extraction job persistence, version CAS and approval,
and version-pinned replay receipts. Mocked/synthetic: CT data, beep WAV/fake mic,
localhost archive, injected Gemini extraction text, provider/cloud transports
in unit tests, offline fonts. No browser render acknowledgement is forged.

**NO LIVE GCP CALL WAS MADE. NOT VERIFIED LIVE — live contract not verified.**
No clinical accuracy, live model contract, deployed behavior or production
microphone latency is claimed. Complete-take replay deliberately rejects an
unprovable partial audio timeline and unknown gaps. Original capture evidence
is preserved when experts edit text or rebind; replay does not synthesize a new
recording from edited findings. Diagnostic receipts do not confer approval.

See EXACT_REPLAY.md and ACCEPTANCE_MAPPING.md. Final logs are retained in
`evidence/m8-*.log` (build progress trailing spaces/CRs normalized only); `m8-roundtrip.png` and `m8-replay-geometry.png` were inspected
locally. No unresolved implementation blocker. The final no-push gate output
and full commit SHAs are appended to `/workspace/radlearn-build-status.md`.
