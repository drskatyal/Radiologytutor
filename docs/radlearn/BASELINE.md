# RadLearn local baseline

Pinned integration: `03f1df5d80af716df54be2a724ff3695be4ca1c9`.
Branch: `codex/radlearn-strategy-build`. The checkout was clean at the start.
All activity is local. No new npm dependencies; `npm ci` was already completed by the orchestrator.

| Command | Result at pinned source |
| --- | --- |
| `npm test` | 1093 tests: 1092 passed, 0 failed, 1 skipped |
| `npx tsc --noEmit` | Exit 2: 281 diagnostics across 96 files (before Next generated its type declarations) |
| `npm run build` | Initial run interrupted with exit 130 while still compiling; Google-font imports were discovered |
| `NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/.radlearn-tmp/offline-fonts.cjs" NEXT_TELEMETRY_DISABLED=1 npm run build` | Exit 0; compile, Next type validation and 39 static pages succeeded |
| `TMPDIR="$PWD/.radlearn-tmp" PW_CHROMIUM_PATH=/home/box/.cache/ms-playwright/chromium-1148/chrome-linux/chrome NEXT_TELEMETRY_DISABLED=1 npx playwright test -c playwright.archive.config.ts --workers=1` | 11 passed, 0 failed: case-viewer.spec.ts (6), student-session.spec.ts (5) |
| RadLearn specs | Not present at the pinned baseline; added in M0 |

Full outputs are in `docs/radlearn/evidence/baseline-*.log`.
The font mock was subsequently moved to `e2e/support/offlineFonts.cjs` for reproducible offline checks.
It uses Next's existing `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` test hook and local Arial fallback; no font assets are downloaded. Typography is mocked for validation only. Application font configuration is unchanged.

Standalone `tsc` includes existing tests with `.ts` imports, incomplete test typings and missing declarations. These failures predate this work; Next's production validation passes. No existing test expectations were weakened. Subsequent checks compare standalone diagnostics against this baseline and report them honestly.

Archive requests and pixels are synthetic and served on localhost. The real app, Next server and Cornerstone renderer are exercised. No Orthanc, remote database or live Gemini is used. **live contract not verified**.

## M0 completion after Git relocation

The synthetic generator now supports the tsx loader without top-level await. Unit suite: 1094 passed, 0 failed, 1 skipped. Archive Playwright: 11 passed; RadLearn synthetic viewer: 1 passed. Offline-font production build passed. Standalone TypeScript: 279 existing diagnostics, no new lines against baseline. Evidence: `evidence/m0-complete-*.log`.
