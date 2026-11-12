# M5 local validation — 12 November 2026

Production authentication URL pre-task and M5 implementation commits:

- `c3411c0`: production public auth URL documentation/examples.
- `fc69604`: shared anchor resolution, reconciliation and calibrated geometry.
- `23ad088`: stale render and malformed geometry fail closed.
- `67749a6`: silent candidates, explicit grouping/omission, exact Jump, pending
  markers and single-finding save integration.

Every subject and commit message ends with ` [skip ci]`. Final evidence/docs
commit and gate output are listed in `/workspace/radlearn-build-status.md`.

| Check | Result |
|---|---|
| npm test | 1,252 total; 1,250 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2; 279 existing diagnostics; 0 new, 0 removed |
| npm run build | Passed; 40 static pages |
| Playwright archive | 11 passed, 0 failed |
| Playwright radlearn | 18 passed, 0 failed |

The TypeScript comparison normalizes only source positions and string-literal
union ordering against `evidence/final-tsc.log`. No diagnostic is filtered and
no test/type configuration was weakened. npm test includes the new anchors
folder. No dependency was added.

Exact final commands, in `/workspace/radlearn-build`:

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test > radlearn-m5-final-test.log 2>&1
npx tsc --noEmit > radlearn-m5-final-tsc.log 2>&1
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build > radlearn-m5-final-build.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1 > radlearn-m5-final-archive.log 2>&1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1 > radlearn-m5-final-radlearn.log 2>&1
```

Final complete outputs are retained in
`evidence/m5-{test,tsc,tsc-comparison,build,archive,radlearn}.log`.
The targeted new markers spec also ran separately: one initial test-selector
failure (the required-label asterisk), corrected without changing production
behavior or an existing assertion, followed by a pass. Early new unit fixtures
were corrected to complete a retained session with valid renderSeq and compare
persisted JSON, rather than JS undefined-valued fields. Final inspection added
stale-render, malformed-geometry, drag and single-editor regressions; the full
suites were rerun after those changes.

Archive specs: `case-viewer.spec.ts` 6/6; `student-session.spec.ts` 5/5.
RadLearn specs:

| Spec | Passed / failed |
|---|---|
| approval | 1 / 0 |
| approved-tools | 2 / 0 |
| capture-recovery | 2 / 0 |
| dicomweb-auth | 1 / 0 |
| exam-leak | 1 / 0 |
| healthz | 1 / 0 |
| markers (new T7, including grouping/omission/undo/drag guard) | 1 / 0 |
| mic-retry | 1 / 0 |
| render-ack | 1 / 0 |
| replay-first-frame | 2 / 0 |
| synthetic | 1 / 0 |
| trusted-host | 4 / 0 |

All configured archive/RadLearn specs executed; none were skipped or marked
passed without running. The synthetic candidate screenshot was inspected from
`test-results/markers-T7-three-silent-ma-20227-otes-save-retains-all-three/marker-candidates.png`.
It shows the three labeled candidates, render confirmations and existing UI
controls. The screenshot is an ignored local artifact, not patient data.

Real: pure geometry transforms, shared resolver/reconciliation, immutable content
hashes, local durable capture/server materialization and retry identity, real
Cornerstone render acknowledgements, IndexedDB and authenticated localhost
routes. Browser data is synthetic DICOM. Marker acceptance mocks microphone
denial; M4 regression specs use Chromium fake-device synthetic audio and real
canvas video. Unit media/clock, cloud HTTP/ADC and Gemini transports are mocked;
fonts use the existing offline fixture. **NO LIVE GCP CALL WAS MADE. Gemini live
contract not verified.** These checks do not verify deployed cloud services,
live model behavior or clinical PHI review.

M5 implements T7 and its portion of T8. The default is one draft per retained
marker; explicit group/omit records and exact SOP/frame Jump are covered.
Preview, notes, segmented save and server AI materialization share a resolver.
Single-finding editors cannot silently collapse markers. Calibrated geometry
uses original spacing provenance and per-frame positions; no 1 mm fallback.
M6 extraction jobs, M7 approval UI and M8 timed geometry/audio replay are not
started. The one CT series / one take / one finding vertical target remains.
See MARKER_ANCHORS.md and ACCEPTANCE_MAPPING.md for exact boundaries.

No blocker. GCP Cloud Run remains the sole deployment target, PRs/merges are
held, and no finding is grandfathered. No push, PR, merge, workflow edit/run,
remote script, deployment or live model call. The final no-push §0.1 gate output
is appended to the external status after all work is committed and clean.
