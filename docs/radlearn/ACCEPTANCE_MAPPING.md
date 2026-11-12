# Claude review acceptance mapping

This adds tests of the ordered strategy milestones. It does not authorise a
merge, deployment, new remote data, or implementation of the deferred milestones.

| Test | Milestone and implementation/test file | Acceptance |
|---|---|---|
| T1 order independence | M0 `lib/synthetic.test.ts`, shuffled synthetic archive fixture; M2 `lib/findingAcceptance.test.ts`; M7 planned `e2e/radlearn/anchor-order.spec.ts` | Archive and shuffled order resolve the approved finding to the same SOP and frame. UI navigation must do the same. |
| T2 no silent fallback | M2 `lib/findingAcceptance.test.ts`; M7 planned `e2e/radlearn/anchor-incomplete.spec.ts` | Removing the SOP makes a finding index-only/incomplete and not approvable; an index never repairs identity. |
| T3 missing instance | M2 `lib/findingAcceptance.test.ts`; M7/M8 planned `e2e/radlearn/replay-missing-instance.spec.ts` | Missing named SOP/frame is unresolved. Never substitute the nearest slice. |
| T4 crash recovery | M4 planned `e2e/radlearn/capture-recovery.spec.ts` | Recovery resumes acknowledged media and journal chunks without loss or duplication. |
| T5 mic failure | M4 planned `lib/journal/recorder.test.ts`, `e2e/radlearn/mic-retry.spec.ts` | Clean permission error; second start succeeds with a new session clock. |
| T6 audio gap | M4 planned `lib/journal/recorder.test.ts`; M8 planned `e2e/radlearn/replay-clock.spec.ts` | Detect discontinuity and reproduce offsets within explicit tolerance. |
| T7 three silent markers | M5 planned `lib/anchors/reconcile.test.ts`, `e2e/radlearn/markers.spec.ts` | Three retained markers produce three candidates without narration; no production cardinality change in M0–M2. |
| T8 measurement round-trip | M5 planned `lib/anchors/geometry.test.ts`; M8 planned `e2e/radlearn/replay-geometry.spec.ts` | Pixel/patient coordinates round-trip; record PixelSpacing/ImagerPixelSpacing/uncalibrated provenance. |
| T9 invalidation | M2 `lib/findingAcceptance.test.ts`, `e2e/radlearn/approval.spec.ts` | Any version contentHash change invalidates approval. Text, marker/coordinates, measurement, view state, rubric, instance-set fingerprint, ordering algorithm, model and prompt versions are covered. Pure reorder with the same SOP/frame and instance set revalidates, preserves approval, and is logged. |
| T10 delayed image load | M4 planned `lib/journal/match.test.ts`, `e2e/radlearn/render-ack.spec.ts`; M8 planned `e2e/radlearn/replay-delay.spec.ts` | Replay waits for the matching render acknowledgement, then resumes or times out; never continues unconfirmed. |

Image identity is Study/Series/SOP Instance UID plus a one-based frame, never a
slice index. M2 has immutable version and approval records; M4 must add render
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
- P0-3/M4: planned `lib/journal/recorder.test.ts` asserts that timestamps follow
  the matching render acknowledgement, including delayed first frame and layout.
- M4/M8: planned `lib/viewerLoad.identity.test.ts` and
  `e2e/radlearn/replay-first-frame.spec.ts` must cover `viewerLoad` retaining an
  old index when a SOP is absent and progressiveStack's archive-offset versus
  sorted-stack first-frame mismatch. M2's resolver fails closed; the viewer
  loading/replay integration is explicitly deferred.
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
  of all valid actions when invalid geometry/range calls are also present. Planned `lib/tutor/queue.test.ts` must prove sequential
  execution with matching acknowledgements.
  The review's blanket claim that this function returns only actions[0] does not
  match this base. Caller execution and acknowledgement remain M9 work.
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
merged or cherry-picked. No staging legacy-finding repair, production no-mic
cardinality change, Claude-session interaction, or demo-403 alteration occurs.

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
the provisional bucket name and Admin confirmation requirement.

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
