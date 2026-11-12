# Claude review acceptance mapping

This adds tests of the ordered strategy milestones. It does not authorise a
merge, deployment, new remote data, or implementation of the deferred milestones.

| Test | Milestone and implementation/test file | Acceptance |
|---|---|---|
| T1 order independence | M0 `lib/synthetic.test.ts`, shuffled synthetic archive fixture; M2 `lib/findingAcceptance.test.ts`; M7 `e2e/radlearn/anchor-order.spec.ts` | Archive and shuffled order resolve the approved finding to the same SOP and frame. UI navigation must do the same. |
| T2 no silent fallback | M2 `lib/findingAcceptance.test.ts`; M7 `e2e/radlearn/anchor-incomplete.spec.ts` | Removing the SOP makes a finding index-only/incomplete and not approvable; an index never repairs identity. |
| T3 missing instance | M2 `lib/findingAcceptance.test.ts`; M7 `e2e/radlearn/replay-missing-instance.spec.ts` (review Jump); M8 timed replay implemented in that spec | Missing named SOP/frame is unresolved. Never substitute the nearest slice. |
| T4 crash recovery | M4 `e2e/radlearn/capture-recovery.spec.ts` | Recovery resumes acknowledged media and journal chunks without loss or duplication. |
| T5 mic failure | M4 `lib/journal/recorder.test.ts`, `e2e/radlearn/mic-retry.spec.ts` | Clean permission error; second start succeeds with a new session clock. |
| T6 audio gap | M4 `lib/journal/recorder.test.ts`; M8 `lib/replay/{player,audio}.test.ts`, `e2e/radlearn/replay-clock.spec.ts` | Detect discontinuity and reproduce offsets within explicit tolerance. |
| T7 three silent markers | M5 `lib/anchors/reconcile.test.ts`, `e2e/radlearn/markers.spec.ts` | Three retained markers produce three candidates without narration; no production cardinality change in M0–M2. |
| T8 measurement round-trip | M5 `lib/anchors/geometry.test.ts`; M8 `lib/replay/geometry.test.ts`, `e2e/radlearn/replay-geometry.spec.ts` | Pixel/patient coordinates round-trip; record PixelSpacing/ImagerPixelSpacing/uncalibrated provenance. |
| T9 invalidation | M2 `lib/findingAcceptance.test.ts`; M7 `lib/review/server.test.ts`, extended `e2e/radlearn/approval.spec.ts` | Any version contentHash change invalidates approval. Text, marker/coordinates, measurement, view state, rubric, instance-set fingerprint, ordering algorithm, model and prompt versions are covered. Pure reorder with the same SOP/frame and instance set revalidates, preserves approval, and is logged. |
| T10 delayed image load | M4 `lib/journal/match.test.ts`, `e2e/radlearn/render-ack.spec.ts`; M8 `lib/replay/player.test.ts`, `e2e/radlearn/replay-delay.spec.ts` | Replay waits for the matching render acknowledgement, then resumes or times out; never continues unconfirmed. |

Image identity is Study/Series/SOP Instance UID plus a one-based frame, never a
slice index. M2 has immutable version and approval records; M4 adds render
records with a monotonic clock. The viewer event journal is the source of timing
and geometry. A 1 fps video is not that journal. Models propose text and rough
windows only; recorded evidence supplies identities, coordinates and timing.

The first end-to-end acceptance target is **one CT series, one take, one finding**
through capture, extraction, expert edit/approval and exact replay. Image-pixel
coordinates on a named SOP/frame belong in that first slice, not a later polish
pass. M0–M2 alone do not claim capture/replay completion.

## Additional P0 tests and boundaries

- M1: `lib/exam/projection.test.ts`, `lib/exam/promptLeak.test.ts`,
  `lib/exam/input.test.ts`, `e2e/radlearn/exam-leak.spec.ts`: neutral opening
  independent of findings; no answer in model context; no Search grounding or
  show_finding/jump_to_key_view/play_guide tools; learner text is PHI checked and
  audio is not an accepted exam payload. Spoken identifiers in transcribed text
  pass the same guard. Existing exam client exposes no provider microphone path.
- P0-1/M2: `lib/findingAcceptance.test.ts` requires Study, Series, SOP and frame
  independently. Index-only rows carry `legacy_index`/incomplete badge data.
- P0-3/M4: `lib/journal/recorder.test.ts` asserts that timestamps follow
  the matching render acknowledgement, including delayed first frame and layout.
- M4: `lib/viewerLoad.identity.test.ts` and
  `e2e/radlearn/replay-first-frame.spec.ts` must cover `viewerLoad` retaining an
  old index when a SOP is absent and progressiveStack's archive-offset versus
  sorted-stack first-frame mismatch. M4 now fails closed in the viewer loader and
  resolves the early SOP/frame against the final order; M8 now verifies timed replay without using that offset as image identity. The tests include real viewer reorder and missing-opening-SOP paths.
- P0-4 pulled forward from M9: implemented `lib/harness/approvedTools.test.ts`,
  caller updates in `lib/gemini.test.ts`, `lib/liveTeachingPack.test.ts`,
  `lib/setSeries.test.ts`, and `e2e/radlearn/approved-tools.spec.ts`.
  REST planning and Live requests use server-built current approval IDs and
  actual DICOM metadata frame counts. point_to/draw_annotation accept only
  anchorId/annotationId; even matching numeric coordinates are rejected.
  scroll_to (and indexed set_series) must resolve inside the real frame range
  AND the approved SOP/frame set. Both client paths revalidate through the
  authenticated, org-scoped server endpoint before resolving the target against
  the currently loaded stack. T1/T2/T3/T9 tool-boundary tests cover reorder,
  missing/duplicate/partial identities, stale versions, edits during metadata
  I/O, and reapproval with new IDs. Exam GET/POST isolation is also tested.
  See APPROVED_TOOLS.md. This does not implement the rest of M9 or replace the
  planned M4/M8 render acknowledgements and exact replay tests.
- P0-8/M9: `lib/gemini.ts` already returns the full validated `actions` list and
  keeps `action` as a compatibility first-action alias on this integration base.
  `lib/gemini.test.ts` ("tools with an empty message get a drive-first authored
  line") still asserts all three returned actions survive, now with approved
  IDs and actual frame inventory. The P0-4 tests also assert ordered retention
  of all valid actions when invalid geometry/range calls are also present. M9 now adds
  `lib/tutor/orchestrator.test.ts` and `e2e/radlearn/tutor-loop.spec.ts` for sequential
  execution with matching acknowledgements. The planned queue.test.ts is named
  orchestrator.test.ts to match strategy §4 M9 and the implemented module.
  The review's blanket claim that this function returns only actions[0] does not
  match this base. M9 now executes all actions through the acknowledged queue.
  Its render-confirmed planner rejects a whole unsupported plan; the legacy
  planner compatibility tests remain unchanged.
- Export/M2 addendum: `lib/exportPhi.test.ts` and native `export_policy.rs` tests cover web/desktop metadata and
  overlay allowlists plus DICOM identity stripping and fail-closed validation.
  PR #130 sketch export is absent. Future test `lib/sketchExport.phi.test.ts`
  must exercise PatientName/ID/BirthDate/Accession/ReferringPhysician stripping,
  unknown-field exclusion and rejection of non-placeholder identities. No port.
  See EXPORT_PHI.md for native dependency/validation limits.
- P0-7/M3: implemented `lib/tts.wav.test.ts` and
  `lib/gemini.request.test.ts` cover unary RIFF/WAV versus streaming audio/l16,
  explicit 3.8 TTS ID and speech_metadata style. See GEMINI_VERIFICATION.md for
  the supplied offline request-schema evidence and API-surface choice.
  `lib/geminiPolicy.test.ts` and `lib/geminiLiveProtocol.test.ts` cover sampling
  removal, including the dedicated correction of the obsolete Live assertion.
  Request snapshots cover extraction, planning and TTS; role rejection, PHI
  guards, resolution forms, provenance and ElevenLabs priority are also tested.
  T1–T10 remain assigned as above; M3 does not claim capture/replay acceptance.

“#252 before #130” is later-merge advice only. Neither branch/PR is touched,
merged or cherry-picked. No staging legacy-finding repair, Claude-session interaction, or demo-403
alteration occurs. M5 now implements the requested no-mic marker cardinality
change locally; nothing is deployed.

## C1 cutover acceptance

`lib/trustedHost.test.ts` covers authenticated forwarded host selection, missing
/wrong/unset secrets, strict hostname validation, constant-time native crypto
verification failure, configured-origin fallback, secret absence from console
and output, SEO origins and upstream-port-safe redirects.
`e2e/radlearn/trusted-host.spec.ts` exercises real local robots/sitemap routes,
landing/layout/viewer metadata and middleware with a synthetic Worker header.
C1 does not implement or reassign T1–T10 or deferred capture/replay milestones.

## C2 cutover acceptance

`lib/c2Storage.test.ts` exercises runtime ADC without credential-file discovery,
private GCS objects, fail-closed durable writes, case/receipt PHI allowlists,
synthetic multipart STOW with matching SOP acknowledgement, QIDO, WADO and
metadata feeding the existing GCS bundle builder. The resulting bundle preserves
the source SOP identity; M2 approval/reorder tests still run unchanged.
Anonymous proxy requests are tested directly and in
`e2e/radlearn/dicomweb-auth.spec.ts`; no ADC/HTTP happens before authorization.
The existing Orthanc and R2 compatibility tests remain. ENV_SCHEMA.md records
the unchanged bucket name and Radlearn/GCP Admin’s reported confirmation (12 Nov 2026); this checkout did not verify it.

**NO LIVE GCP CALL WAS MADE.** Cloud transports and tokens are mocked; local
de-identification, encoding, storage serialization and route authorization are
real. C2 does not reassign or claim completion of deferred T1–T10 capture/replay
work, render acknowledgement, multi-marker extraction or M9 tools.

## Step B deployment preparation acceptance

`lib/cloudRunStartup.test.ts` validates every required C2/PACS setting, malformed
configurations, variable-name-only errors, actual compiled Node preload failure
before server code, PORT defaults/overrides, dependency-free liveness, Docker
source/secret exclusions, non-root standalone startup, removed Railway config,
health probes and the desktop public update origin. Docker is unavailable, so
these are static image checks, not a claimed docker build. No new dependencies.
`e2e/radlearn/healthz.spec.ts` checks anonymous GET/HEAD on the real local Next app.
The production preload has no test-mode escape; existing local Playwright
fixture runners use their separate direct Next command with JSON/mock Orthanc.

No T1–T10 or P0 capture/replay test moves into Step B. All prior milestones'
unit/browser checks rerun; runtime dependency availability and deployed image
health remain GCP Admin's separate verification after the hold is released.

## M4 capture acceptance

Implemented T4/T5/T6 capture portions and T10/P0-3 renderer portions:
`lib/journal/{match,viewer,recorder,storage}.test.ts`,
`lib/viewerLoad.identity.test.ts`, the child-track regression in
`lib/captureSession.test.ts`, and browser specs
`e2e/radlearn/{capture-recovery,mic-retry,render-ack,replay-first-frame}.spec.ts`.
The browser uses real Cornerstone renders, IndexedDB transactions, local
authenticated Next routes, local durable objects, canvas video and a fake mic
playing the synthetic WAV. Delays affect real rendering; no IMAGE_RENDERED is
forged. Recovery sends missing chunks after reconciling server receipts and
retains the exact acknowledged journal prefix. A marker records image pixels
on the displayed SOP/frame; annotation/measurement calibration is explicitly
unresolved until M5.

T6 detects delayed delivery and pause/resume with explicit estimated timing.
T10 verifies the request/ack boundary and timeout, including Restore captured
view; the full timed replay scheduler and ≤100 ms audio drift acceptance are
still M8 tests, not claimed here. Crash recovery finalizes the retained take
with an explicit interruption and unknown unretained tail, rather than making
up elapsed time from a dead browser clock. A new take receives a new UUID/clock.
The one CT series / one take / one finding end-to-end target remains binding
through the later extraction, approval UI and replay milestones.

See JOURNAL_CAPTURE.md for durability, timing limits, PHI review, model upload
gates, and the exact acceptance boundaries. No M5+ implementation is implied.

## M5 marker and geometry acceptance

T7 and the M5 portion of T8 are implemented: shared resolver/reconciliation on
preview, notes, segmented and server AI save paths; retained marker undo/removal;
explicit group/omit records; calibrated original image pixels and patient mm
with spacing provenance and per-frame positions. `lib/anchors/commit.test.ts`
exercises local durable capture completion and server materialization, including
retry identity and foreign-org rejection. `lib/anchors/singleEditor.test.ts`
checks the older single-finding caller shares anchors and requires explicit
multi-marker grouping before any media request. `lib/anchors/resolve.test.ts` checks
preview/commit equality and fail-closed cases; `lib/journal/recorder.test.ts`
checks persisted geometry/undo, and `lib/studioHotkeys.test.ts` protects typing.

`e2e/radlearn/markers.spec.ts` checks three silent candidates, exact acknowledged
SOP/frame jumps and three persisted notes findings using the real local viewer.
No M6 extraction implementation or M7 approval surface is included; M8 still
owns measurement replay, timeline synchronization and drift. See MARKER_ANCHORS.md
and M5_VALIDATION.md for the contract, test results and remaining limits.

## M6 extraction acceptance

Implemented `lib/extract/{schema,prompt,run,materialize,client}.ts` and tests
`lib/extract/{prompt,run,materialize,client}.test.ts`, plus
`e2e/radlearn/extraction.spec.ts`. Required M6 adversarial-output, persisted
job/result replay, PHI/canary prompt exclusion and lost-commit-response tests
are present. The latter creates exactly two findings, preserves a later expert
version and checks immutable source receipts. Concurrent requests/commits,
expired-worker fencing and edits during model I/O are also exercised.

T7's retained-marker cardinality remains binding at extraction: empty model
output does not erase markers, and explicit group/omit decisions are frozen and
recorded. T8's native measurement evidence keeps named SOP/frame, pixels and
spacing provenance; removed annotation revisions cannot be resurrected by a
model reference. T9's version hashing/CAS extends to extraction source,
confidence, issues and request provenance. P0-3's render acknowledgement is
reused by M5 resolution, including a contradictory renderSeq rejection.
Invalid/overlapping windows remain estimated/unresolved and unknown timestamps
stay null. The obsolete proportional-time test was corrected in its own commit;
see M6_TIMING_CORRECTION.md.

The original T1–T10 milestone assignments remain unchanged. M6 does not claim
M7 approval navigation, M8 replay timing/geometry/drift, or the remaining M9
queue work. See EXTRACTION.md and M6_VALIDATION.md for the implementation,
real-versus-mocked boundary and local evidence. **live contract not verified**;
**NO LIVE GCP CALL WAS MADE**.


## M7 review acceptance

Implemented T1/T2/T3 review navigation in the specs above and
`e2e/radlearn/review-jump.spec.ts`: real single-frame and multiframe Jump, full
view match, delayed actual render, shuffled metadata, missing SOP without index
substitution, incomplete identity and explicit rendered rebind. Retained audio
seeks to capture time minus stream offset. Annotation/measurement calibration
badges are checked. `lib/review/client.test.ts` rejects mismatched or superseded
acks and stale point capture; `lib/viewerSource.test.ts` keeps a pending render
coordinator alive across series changes within the same archive rail.

T9's UI extension in `approval.spec.ts` covers PHI-disabled approval, keyboard
focus and activation, per-version approval, edit invalidation, history diff,
approved-only retrieval, a concurrent-save conflict without losing local text,
unsaved-tab navigation and mobile overflow. `lib/review/server.test.ts` verifies
fresh inventory, logged reorder revalidation, hash/version checks, calibrated
rebind, explicit uncertainty resolution audit, org/case isolation and version
changes during metadata I/O. The extended M6 extraction spec now reviews and
approves its actual retained-capture draft on the recording page.

The one-series/one-take/one-finding path now reaches expert review and approval.
Exact **timed replay**, T6's drift tolerance and T10's replay hold/resume remain
M8 acceptance; M7's Jump acknowledgement does not claim their completion. No
additional T4/T5/T7 or P0 implementation is moved into this milestone.
See FINDING_REVIEW.md for behavior and M7_VALIDATION.md for executed evidence.


## M8 exact replay acceptance

T3/T6/T8/T10 replay portions are implemented in the files mapped above. Every
journal render/layout entry is requested and acknowledged before the shared
clock and recorded audio continue. Missing identity, unknown audio gaps,
unsupported geometry and timeouts stop visibly and report a miss. First-frame
time and SOP/frame survive a deliberately invalid index hint. The same player
backs author take preview and current-approved-finding replay; diagnostic
receipts pin version/hash and do not grant approval.

`e2e/radlearn/replay.spec.ts` completes the first **one CT series / one take /
one finding** capture → retained extraction → expert edit/approval → exact
replay round trip. Real local capture, render acknowledgements and geometry are
used; only the model response is injected. Synthetic beep drift is measured
from decoded Web Audio output in `replay-clock.spec.ts` (≤100 ms per cue).
See EXACT_REPLAY.md and M8_VALIDATION.md for evidence and limitations. That M8 evidence does not claim tutor queue coverage; the M9 evidence below does.


## M9 implementation and acceptance evidence

- P0-8: `lib/tutor/orchestrator.test.ts` checks every ordered action before
  speech, delayed/reordered/wrong/failed/timed-out renders, cancelled generations,
  late speech completion and speech failure. `tutor-loop.spec.ts` observes actual
  render snapshots at real `audio.play`, including three actions before one
  sentence, and cancellation before later actions/utterances.
- P0-4 and T1/T2/T3/T9 regressions: existing approved-tool/anchor tests remain.
  `lib/tutor/commands.test.ts` adds strict named finding/anchor/annotation and
  exact SOP/frame commands, window/zoom bounds, foreign/unapproved identities,
  original image-pixel highlights and spacing provenance. `planner.test.ts`
  checks the supported request tools, full ordered list, numeric coercion
  rejection and fail-closed unsupported/foreign-series plans.
- T9 at the speech boundary: every action and speech release checks fresh
  approvals. The browser spec edits a finding during rendering and proves no
  speech starts. Stored answers keep their original approval IDs and spoken
  command beats; replay does not adopt edited evidence.
- T10 at the tutor boundary: delayed real render frames hold speech; missing or
  mismatched identity/acknowledgement fails closed. Existing M4/M8 replay
  acceptance remains intact; M9 does not change replay geometry/timing.
- Held voice: `holdToTalk.test.ts` covers repeat/release, min/max duration,
  blur/visibility/Escape, permission denial and late permission, plus immediate
  barge-in while transcription is pending. Browser STT and teaching remain
  separate calls. No persistent Live microphone is opened.

See TUTOR_LOOP.md and M9_VALIDATION.md. The only changed old assertion is the
fullscreen microphone's name (Open microphone → Hold to ask), documented and
committed separately in M9_TEST_CHANGES.md. No assertion is skipped or weakened.
Synthetic data only; STT, model and TTS transport are mocked. **live contract not
verified. NO LIVE GCP CALL WAS MADE.** M10 has not started.

## M10 — examiner mode end-to-end

M10 builds on the M1 isolation contract and preserves T1–T3/T9 identity and approval
invariants; it does not introduce another capture/replay milestone. Implemented
acceptance coverage:

- `e2e/radlearn/exam-flow.spec.ts`: full report/point/held-voice attempt, neutral
  opening and hints, recorded retry and assistance, active receipt with no score,
  deterministic closed score/evidence, separate explicit reveal and closed reload.
  Point answers use the actual render-confirmed SOP/frame and image pixels. Unknown
  SOPs, frame overflow and out-of-image points fail closed on the server.
- The same spec scans HTML, RSC, JSON, API bodies and socket frames across the full
  attempt before reveal. `playwright.exam.config.ts` additionally exercises the
  real STT/TTS/structure routes with a server transport mock and scans model request
  bodies. No reference finding, diagnosis or answer-bearing context reaches the
  model; no Search, guide/navigation tools or provider WebSocket is opened.
- The API flow also covers ownership, close-before-answer, close-before-reveal,
  PHI/audio review, revision conflicts, idempotent save/retry after close, and a
  new active exam blocking the previous key's reveal.
- `lib/exam/score.test.ts`, `attempt.test.ts`: reproducibility, hints/retries and
  persistent assistance, latest-current-try scoring (no best-of-history), wrong
  SOP/frame rejection, neutral examiner speech request and stale-render point guard.
- `lib/exam/store.test.ts`: competing revisions cannot both commit; cross-owner
  mutations fail. Existing `promptLeak.test.ts` and `exam-leak.spec.ts` stay intact.

See [EXAMINER.md](EXAMINER.md) for server boundaries and scoring semantics. M10
completes the strategy's final milestone; no later milestone is started.
**All model/audio provider output is mocked. NOT VERIFIED LIVE; live contract not
verified. NO LIVE GCP CALL WAS MADE.**
