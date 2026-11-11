# RadLearn local handoff

M0, M1 and M2 are implemented and locally committed, followed by the mandatory
review acceptance, examiner isolation and export addenda. The earlier Git metadata
permission block was resolved by the orchestrator; all implementation commits
are on codex/radlearn-strategy-build with [skip ci] messages. No push, PR, merge,
workflow edit, remote script, live model call or deployment occurred.

The final version-history audit also fixes restore-after-delete numbering,
compile retries after an expert deletion, authenticated author attribution on
finding writes, and stale badge state after a confirmed inventory mismatch.

Final root validation: 1,137 unit tests pass, zero fail, two documented skips;
production build passes; tsc retains exactly 279 baseline diagnostics. Final
browser checks: archive 11 pass, RadLearn 3 pass, export 1 pass. One archive
viewer-readiness timeout occurred while two browser configs ran concurrently;
a sequential full archive rerun passed 11/11. Both outputs are retained. Native
policy: 2 pass. Full native integration, desktop-only tsc and local Mongo remain
unverified for the dependency/server reasons in BASELINE.md and EXPORT_PHI.md.

All imaging fixtures are synthetic. JSON storage, local author sign-up, approval,
exam isolation, viewer pixels and browser exports are real. Gemini transport and
font responses are mocked: **live contract not verified / NOT VERIFIED LIVE**.

The four strategy defaults remain binding in DECISIONS.md. Optional M3 TTS and
M9 parser changes were evaluated and deferred there with concrete reasons.
The full action-list behavior already has a passing existing regression test.
Future capture/replay requirements are mapped, not claimed implemented, in
ACCEPTANCE_MAPPING.md. GEMINI_VERIFICATION.md records the supplied official-doc
claims, including the time-sensitive TTS deadline and unverified mediaProcessing
field. No #130/#252 code was ported or cherry-picked.

Exact commands, per-step commits, failures/skips and final read-only gate output
are maintained in /workspace/radlearn-build-status.md. Milestone and final raw
logs are in docs/radlearn/evidence/. The orchestrator owns the push/deployment gate.

## M3 — adapter alignment and TTS migration

M3 is implemented locally using the orchestrator's offline Google docs. TTS
defaults to gemini-3.8-flash-tts on unary Interactions with speech_metadata style.
The text adapter retains generateContent; Live retains its separate model.
Sampling fields are removed for 3.6+ and 3.5 Flash Lite, media resolution has an
explicit object/string switch, and unsupported roles fail with typed errors.
WAV bytes are preserved; raw L16 receives one WAV header. ElevenLabs priority
and the existing explicit attending-guide Gemini route remain intact.

Validation: 1,156 unit tests passed, 0 failed, 2 existing skips; build passed;
tsc reports 279 existing diagnostics, no additions (line offsets and union
display order normalized). Archive browser suite: 11 passed. RadLearn: 3 passed.
The first tsc run found 10 new test import-extension errors; those were fixed
and the baseline comparison rerun. M3 tests and request snapshots are listed in
ACCEPTANCE_MAPPING.md. No T1–T10 capture/replay work was moved into M3.

The prior TTS-schema deferral is resolved; GEMINI_VERIFICATION.md explains the
API choice and remaining mediaProcessing/mediaResolution verification limits.
All provider calls use mocked responses: **NOT VERIFIED LIVE — live contract
not verified**. No new dependency, remote data, deployment, push, PR or M4+ work.
GCP Admin owns any future Cloud Run deployment; the orchestrator owns pushes.
