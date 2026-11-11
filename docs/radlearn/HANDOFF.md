# Historical stop (resolved by orchestrator)

The orchestrator relocated Git metadata to `/workspace/radlearn-build-gitdir`; staging now works. The notes below preserve the earlier stop and are not current status.

# Stopped during M0: read-only Git metadata

No commits were created. HEAD remains `03f1df5d80af716df54be2a724ff3695be4ca1c9` on `codex/radlearn-strategy-build`.

The runtime mounts `.git` read-only. The first staging attempt failed:

```text
$ git add docs/radlearn/BASELINE.md docs/radlearn/DECISIONS.md docs/radlearn/evidence
fatal: Unable to create '/workspace/radlearn-build/.git/index.lock': Read-only file system
```

Implementation stopped. M0 is incomplete; M1 and M2 were not started. No push, PR, deployment, GitHub Actions run or `.github` modification occurred. The working tree cannot be made committed and clean under these permissions. Uncommitted source and evidence are preserved for resumption after the orchestrator makes this clone's Git metadata writable.

The new synthetic fixture files and test harness have not met acceptance. The M0 unit run has one new test-file failure: the current tsx CommonJS transformation rejects top-level await in `scripts/make-synthetic-study.mjs` when loaded by `lib/synthetic.test.ts`. No existing test was edited. This needs a local loader-compatible entry point when implementation resumes. RadLearn Playwright was not executed before the stop. The original archive Playwright baseline passed all 11 tests.

The first M0 standalone TypeScript attempt overlapped Next's regeneration of `.next/types` and reported 96 missing generated files; do not treat that attempt as a source regression. Final evidence is recorded separately after the build finishes.

See `/workspace/radlearn-build-status.md` for exact commands, outputs, final validation counts and pre-push gate evidence. The gate is blocked: `git fetch origin` cannot open `.git/FETCH_HEAD` for writing. The local integration ref still equals the pinned SHA; its current remote tip was not verified. All four workflows are manual-only and the `.github` diffs are empty. Actions permissions are readable and enabled, with `allowed_actions: all` and `sha_pinning_required: false`.

The four strategy §7 defaults are in `DECISIONS.md`. No live Gemini calls were made: **live contract not verified**.
