# Strategy §7 defaults

## Deployment target and branch push (Sanyam, 11 Nov 2026)

- **Google Cloud (Cloud Run, owned by GCP Admin) is the only intended deploy target for RadLearn.**
  Railway is legacy: it still auto-deploys the integration branch `claude/epic-noether-3nvcbf`
  (`railway.json`, `flowrad-learn / production`), so that branch must never be pushed from this build.
  This build never deploys anywhere; any Cloud Run deployment is a GCP Admin decision outside this branch.
- **Historical branch push approval (orchestrator only under current instructions):** "Yes, push the RadLearn build branch once the no-Actions check passes."
  The build agent never pushes. The orchestrator owns any later push after its
  own no-Actions gate. Current M3 instructions prohibit agent pushes and all PRs.
- **No grandfathering stands (decision 1 confirmed):** published cases need re-approval of their current
  finding versions before tutor or exam grounding uses them.
- **PRs are held:** no PR (not even draft) is opened from this branch until Radlearn confirms the Railway
  GitHub integration and PR previews are fully disconnected. Pushes go to `codex/radlearn-strategy-build` only.
- Read-only evidence on 11 Nov 2026 (GitHub API): all 264 repository deployments are
  `flowrad-learn / production` by `railway-app[bot]`; none is on a PR head SHA (15 most recent PRs, including
  open drafts #252/#130, have zero deployments, statuses or check runs); only one environment exists; no repo
  webhooks. No Railway PR-preview activity was observed.


1. Existing published cases retain browse access but lose tutor and exam grounding until their current finding versions are re-approved. No grandfathering migration.
2. TTS shutdown work remains draft work for M3, outside this M0–M2 task. No hotfix or deployment.
3. Hosting and pushes: see "Deployment target and branch push" below. (Original default: no PR until Railway PR environments were confirmed off.)
4. Exam models may structure learner free text only. Scoring is deterministic on the server against a pinned private rubric.

All Gemini calls in validation are mocked; **live contract not verified**.

## Addendum options evaluated after mandatory local checks

- Items 9/13: **optional M3 TTS slice deferred**. The supplied verification confirms
  the replacement model and WAV/L16 behavior, but does not specify the exact
  speech_metadata request schema/nesting for this REST adapter. New documentation
  fetches are forbidden in this run. Guessing that schema is not a safe complete
  migration; changing only the ID/decoder would leave the requested style move
  incomplete. Keep the 17 November deadline visible for the next draft M3 task.
  No TTS defaults, deployment or live calls changed. NOT VERIFIED LIVE.
- Item 12: **optional M9 parser changes deferred**. Safe coordinate rejection and
  scroll bounds need approved anchor IDs and actual frame counts propagated to
  callers; a local numeric clamp would not establish that contract. Tests are
  mapped to M9. The full action-list return already exists and its three-action
  regression test in lib/gemini.test.ts passes; no replacement is necessary.
- Required capture/replay/geometry work remains mapped to M4/M5/M7/M8/M9. No work
  on those milestones, production cardinality, staging legacy data, or the held
  PR branches was started.

## M3 authorization and resolved TTS hold

The current M3 request explicitly authorizes adapter/TTS implementation and
`.env.example` updates, with no deployment, PR or push. The earlier optional-slice
deferral above is historical: the offline speech-generation REST example now
resolves the schema. Use Interactions for TTS, retain generateContent for text,
and default to gemini-3.8-flash-tts. See GEMINI_VERIFICATION.md. GCP Cloud Run /
GCP Admin remains the only future deployment target, controlled separately by
the orchestrator. No grandfathering and deterministic server exam scoring stand.
NOT VERIFIED LIVE.
