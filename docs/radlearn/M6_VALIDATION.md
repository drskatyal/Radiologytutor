# M6 local validation — 12 Nov 2026

Scope: strategy §4 M6 only. The obsolete timing test correction is isolated in
`a97d15f`; retained extraction, routes/caller, version receipts and tests are in
`fedd869`. No M7+ work, remote services, push, PR, merge, workflow or deployment.
No dependency was added. GCP-only deployment, held PRs/merges, no grandfathering
and the existing `GCS_OBJECT_BUCKET` schema constant remain unchanged.

| Check | Result |
|---|---|
| npm test | 1,271 tests: 1,269 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2: 279 existing diagnostics; 0 new, 0 removed |
| npm run build with local font mock | PASS; 40 static pages and production environment preload |
| Playwright archive, final complete rerun | 11 passed, 0 failed |
| Playwright radlearn | 19 passed, 0 failed |
| New extraction spec, targeted run | 1 passed, 0 failed |
| New extraction + existing resolver unit subset | 23 passed, 0 failed |

The TypeScript comparison normalizes only source positions and string-literal
union ordering against `evidence/final-tsc.log`. No diagnostic is filtered, no
type/test configuration is weakened. Existing skips: local Mongo integration
(no local mongod; no remote Mongo allowed), and the pre-existing SR/KO fixture
test. Mongo transport/CAS mocks still run as part of the unit suite.

Exact final commands, run from `/workspace/radlearn-build`:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-m6-final-test.log 2>&1
npx tsc --noEmit > radlearn-m6-final-tsc.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-m6-final-build.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-m6-final2-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-m6-final-radlearn.log 2>&1
```

Full outputs are retained in `evidence/m6-{test,tsc,tsc-comparison,build,archive,radlearn}.log`.
The earlier timing-only checkpoint ran 1,253 tests: 1,251 passed, 0 failed,
2 existing skips, and passed the build. See M6_TIMING_CORRECTION.md for why the
old missing-time expectation was replaced in its dedicated commit.

During development a new negative test exposed a contradictory marker
renderSeq accepted by the shared resolver. The implementation now rejects it;
all existing resolver assertions remain unchanged. The first new browser test
attempt scrolled forward from the fixture's last slice; it now opens the first
slice explicitly. The complete first archive run passed 10/11 with an existing
phone sketch-card timeout. That test passed unchanged in isolation, followed by
an unchanged full 11/11 rerun. These earlier failures are not represented as
passes; the final results above are from executed reruns.

Real: local recorder/render acknowledgements, IndexedDB, retained media checksum
validation, file-backed case mutations, jobs, authenticated Next routes and
version commits. Synthetic/mocked: CT/pixels, fake-mic WAV and browser canvas
video, localhost archive, Gemini generation/Files responses and offline fonts.
The browser uses a guarded local fixture process to inject the model into the
same persisted job runner; no production bypass or live endpoint is configured.

**NO LIVE GCP CALL WAS MADE. NOT VERIFIED LIVE — live contract not verified.**
Provider compatibility, clinical extraction quality, deployed image behavior
and production latency were not tested. See EXTRACTION.md for the bounded
request/lease/retry contract and ACCEPTANCE_MAPPING.md for remaining M7/M8/M9
acceptance. No strategy deviation or outstanding implementation blocker.

Archive specs executed: `case-viewer.spec.ts` 6/6 and
`student-session.spec.ts` 5/5. RadLearn specs executed:

| Spec | Passed / failed |
|---|---|
| approval | 1 / 0 |
| approved-tools | 2 / 0 |
| capture-recovery | 2 / 0 |
| dicomweb-auth | 1 / 0 |
| exam-leak | 1 / 0 |
| extraction (new M6) | 1 / 0 |
| healthz | 1 / 0 |
| markers | 1 / 0 |
| mic-retry | 1 / 0 |
| render-ack | 1 / 0 |
| replay-first-frame | 2 / 0 |
| synthetic | 1 / 0 |
| trusted-host | 4 / 0 |

No configured archive/RadLearn spec was omitted. The final synthetic extraction
screenshot was inspected locally at
`test-results/extraction-M6-retained-ext-fa980-nse-and-a-later-expert-edit/extraction-committed.png`.
It shows exactly two findings, the later expert label, the draft-success notice
and recorded media review. The prior intentional network-failure toast is still
visible in that immediate screenshot. Existing studio “exam-ready” copy counts
legacy content completeness; it does not confer server approval. Stored versions
remain `needs_review`; M7 owns the approval/badge surface.
