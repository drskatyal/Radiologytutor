# M4 local validation — 12 November 2026

Bucket pre-task and M4 implementation commits:

- `01ad463f6f747454de583c98783cf1ef1b111913`
- `64be06181195bbea0e297de1a1906e42cf945cf5`
- `7eb4cfb4d7bb29a2e2268c678a1ebfdb7a5bba20`
- `5312472f06117892061d585b05e245b0aa18b409`
- `679111189d401a664b2a3c8c67ac2d4649152a95`

All commit subjects end in ` [skip ci]`. The final evidence/docs commit is
listed in `/workspace/radlearn-build-status.md`.

| Check | Result |
|---|---|
| npm test | 1,231 total; 1,229 passed, 0 failed, 2 existing skips |
| npx tsc --noEmit | Exit 2; 279 existing diagnostics; 0 new, 0 removed |
| npm run build | Passed; 40 static pages |
| Playwright archive | 11 passed, 0 failed |
| Playwright radlearn | 17 passed, 0 failed |

TypeScript comparison uses `evidence/final-tsc.log` as the existing 279-error
baseline, normalizing source positions and string-literal union ordering only.
It does not filter out diagnostics. The production build succeeds under the
repository's existing configuration; no test or type configuration was weakened.

Exact commands (working directory `/workspace/radlearn-build`):

```bash
TMPDIR="$PWD/.radlearn-tmp" npm test
npx tsc --noEmit
NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/e2e/support/offlineFonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1
TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.radlearn.config.ts --workers=1
```

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
| mic-retry | 1 / 0 |
| render-ack | 1 / 0 |
| replay-first-frame | 2 / 0 |
| synthetic | 1 / 0 |
| trusted-host | 4 / 0 |

Complete final outputs are `evidence/m4-{test,build,tsc,tsc-comparison,archive,radlearn}.log`.
Intermediate failed attempts and their local fixes are recorded in the external
status file: synthetic study ownership, unambiguous button selection, honoring
auth Retry-After, a test's zero/one-based index comparison, and correcting the
snapshot reader to the existing DICOM-linear VOI conversion. A final optional
track type narrowing was also fixed locally. No assertion was relaxed to accept
an unconfirmed render, substituted SOP, lost chunk, or widened tolerance.

Real: Cornerstone rendering, journal timestamps, image-pixel projection, browser
IndexedDB transactions, localhost authentication/authorization and HTTP routes,
local durable object I/O, canvas video, and Chromium's fake-device microphone
fed the synthetic tone WAV. Unit media devices/clocks, cloud HTTP/ADC and Gemini
are mocked. **NO LIVE GCP CALL WAS MADE. Gemini live contract not verified.**
No packages were added. The bucket's name/configuration is reported by Radlearn/
GCP Admin, not independently verified. Production deployment, cloud storage
behavior and clinical/media PHI review are not claimed by these local tests.

T4/T5/T6 capture and T10/P0-3 renderer acceptance is implemented. The M8 timed
replay scheduler and ≤100 ms cue drift test remain planned, as do M5 marker
reconciliation/calibration and subsequent extraction/approval work. Recovery
finalizes the retained interrupted take and marks its unknown tail; a new take
gets a new clock. See JOURNAL_CAPTURE.md and ACCEPTANCE_MAPPING.md.

No blocker. No push, PR, merge, Actions edit/run, remote script, deployment or
live model call. The final §0.1 gate output is appended to the status file after
the tree is committed and clean. M5 was not started.
