# Strategy §7 defaults

1. Existing published cases retain browse access but lose tutor and exam grounding until their current finding versions are re-approved. No grandfathering migration.
2. TTS shutdown work remains draft work for M3, outside this M0–M2 task. No hotfix or deployment.
3. Railway PR environments remain unconfirmed. No PR is opened; no push is authorized for this clone.
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
