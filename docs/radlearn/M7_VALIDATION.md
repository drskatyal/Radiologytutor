# M7 local validation — 12 Nov 2026

Scope: strategy §4 M7 and its mapped T1/T2/T3/T9 review UI acceptance. No M8+
implementation, remote service, push, PR, merge, workflow or deployment. No new
dependency or environment name. GCP-only deployment, held PRs/merges, no
published-case grandfathering and `GCS_OBJECT_BUCKET` remain unchanged.

Backend review/edits are committed in `e32e87d`; viewer/UI/browser coverage in
`c179e83`. Both implementation checkpoints were validated with the complete
working-tree unit suite and production build. Final results:

| Check | Result |
|---|---|
| npm test | 1,283 tests: 1,281 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2: 279 baseline diagnostics, 0 new, 0 removed |
| npm run build, offline fonts | PASS; 40 static pages and runtime environment preload |
| Playwright archive | 11 passed, 0 failed |
| Playwright RadLearn | 24 passed, 0 failed |
| git diff --check | PASS |

No configured archive/RadLearn spec was omitted. The previous milestone's
baseline is M6 commit `becb209f4a261fffc9fcc7ba73a5b0d2875fcc6d`:
1,271 tests, 1,269 passed, 0 failed, 2 existing skips; 279 TypeScript diagnostics;
production build passed; archive 11/11 and RadLearn 19/19 passed.

Exact final commands from `/workspace/radlearn-build`:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-m7-final-test.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-m7-final-build.log 2>&1
npx tsc --noEmit > radlearn-m7-final-tsc.log 2>&1
python3 .radlearn-tmp/m7-compare-tsc.py > radlearn-m7-tsc-comparison.log
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-m7-final4-radlearn.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-m7-final-archive.log 2>&1
```

TypeScript comparison normalizes source positions and string-literal union
ordering only against `evidence/final-tsc.log`; no diagnostics are filtered.
Existing skips are local Mongo integration (no local mongod, no remote Mongo
allowed) and the pre-existing SR/KO fixture test. Mongo mocks still execute.

Development failures were resolved, not counted as passes:

- Initial six-spec review selection: 5 passed, 1 failed. Cross-series Jump
  cancelled because the selected source rebuilt the renderer. A focused rerun
  reproduced 0/1; the archive rail now keeps its renderer/coordinator alive.
- Next four-test selection: 2 passed, 2 failed. Cornerstone ignores pan deltas
  below one pixel; recorded-pan application now crosses that deadband without
  widening the existing 0.5-pixel acknowledgement tolerance. A fast capture
  marker crossed the actual microphone-start discontinuity; the fixture now
  waits for both media-start journal entries before recording its continuous
  evidence interval. Production discontinuity rejection remains unchanged.
- First complete RadLearn run: 23 passed, 1 failed (signup 429). The new test's
  dynamic fixture import duplicated the synthetic-author cache; it now uses the
  shared static import. The existing approved-tools signup helper also respects
  429 Retry-After, as captureFixture already does. Auth limits and all existing
  success/isolation assertions are unchanged.
- Second complete run: 23 passed, 1 failed (review checkbox hidden by fixed
  header). Third: 22 passed, 2 failed (pointer-focus scrolling interrupted a
  checkbox click, plus signup backoff). Review focus scrolling now applies only
  to visible keyboard focus; the keyboard acceptance operates all PHI checkboxes
  with Space and asserts that their focus is below the fixed header. Pointer
  activation remains native.
- One intermediate tsc ran during Next's generated-type replacement and saw 28
  missing `.next/types` files. The final tsc runs after the build. This transient
  command-order failure is not classified as a baseline diagnostic.

Earlier unit checkpoints: 8/8 review tests; full 1,279 total / 1,277 pass / 0
fail / 2 skip; then 1,280 total / 1,278 pass / 0 fail / 2 skip; then 1,282 total /
1,280 pass / 0 fail / 2 skip. New geometry/calibration tests increase the final
count. No existing assertion was removed or relaxed. No render event or success
ack is forged in the browser tests.

Real: Cornerstone pixels and renders, full view-state comparisons, authenticated
Next routes, org scoping, retained-media reads/checksums, JSON case locks/version
CAS, approval retrieval, IndexedDB/capture and UI input/navigation. Synthetic or
mocked: CT instances/pixels, fake microphone WAV and canvas recording, localhost
archive, model/Files transports, cloud transports and offline font responses.
The M6 extension uses its actual retained capture and injected synthetic model
job, then real review Jump and approval on the recording page.

**NO LIVE GCP CALL WAS MADE. NOT VERIFIED LIVE — live contract not verified.**
Clinical correctness, deployed behavior, live model compatibility and production
latency are not claimed. M8 timed replay/drift and M9 tutor execution remain
unimplemented. See FINDING_REVIEW.md and ACCEPTANCE_MAPPING.md for boundaries.


Final outputs are retained in `evidence/m7-{test,tsc,tsc-comparison,build,archive,radlearn}.log`.
Screenshots `evidence/m7-review-{desktop,mobile}.png` were inspected locally;
the mobile view has no horizontal overflow and shows visible input focus.

Archive specs executed: `case-viewer.spec.ts` 6/6, `student-session.spec.ts` 5/5.
RadLearn specs executed (all 0 failures):

| Spec | Passed |
|---|---|
| anchor-incomplete (new) | 1 |
| anchor-order (new) | 1 |
| approval (extended) | 2 |
| approved-tools | 2 |
| capture-recovery | 2 |
| dicomweb-auth | 1 |
| exam-leak | 1 |
| extraction (extended) | 1 |
| healthz | 1 |
| markers | 1 |
| mic-retry | 1 |
| render-ack | 1 |
| replay-first-frame | 2 |
| replay-missing-instance (new, review only) | 1 |
| review-jump (new) | 1 |
| synthetic | 1 |
| trusted-host | 4 |

No outstanding implementation blocker. The two renderer corrections and local
fixture timing/backoff changes are required to exercise M7's exact-image and
keyboard contracts; they do not implement M8 replay or weaken prior assertions.
The UI keeps the existing studio style and primitives. Final §0.1 no-push gate
output and all commit SHAs are appended to `/workspace/radlearn-build-status.md`.
