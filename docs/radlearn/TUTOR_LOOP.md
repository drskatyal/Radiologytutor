# M9: held voice and render-confirmed tutor commands

The learner holds Space or the microphone button, then releases to send. One
MediaRecorder capture is allowed at a time. Repeated keydown events do nothing.
A tap shorter than 250 ms is discarded; 30 seconds ends and sends a capture.
Blur, a hidden document, Escape, pointer cancellation and unmount stop and
discard it. A permission grant arriving after release is immediately closed.
A failed permission request leaves the next hold available.

The learner first confirms that their question contains no patient identifiers.
The audio envelope carries that flag; recognized text and chat history also pass
`assertNoPhi`. This is human review plus a conservative text check, not automated
identification of every possible spoken identifier. STT (`/api/transcribe`) and
teaching (`/api/tutor`) remain separate calls. The default tutor opens no Live
socket. The optional Live adapter remains outside this held REST flow.

`lib/tutor/commands.ts` is a dependency-free strict schema. The authenticated,
org-scoped `/api/cases/[caseId]/tutor-commands` endpoint checks published current
approvals and real metadata inventory for every action. Exam attempts are denied.
Commands reference finding, anchor or annotation IDs, or an exact approved
series/SOP/frame. Index-only identities, free coordinates, out-of-range window
or zoom values, foreign series and obsolete approval IDs fail closed.

The server resolves the approved recorded view. Window/zoom/invert commands may
preserve a renderer's camera only on that same approved image. Highlight uses
the approved annotation's original image pixels and spacing provenance; the
model supplies its ID, never its coordinates. Legacy annotations without the
recorded pixel evidence need rebind/reapproval. The primary stack viewport ID
is bound to the current renderer instance; MPR is not a stack target.

`lib/tutor/orchestrator.ts` executes the complete ordered action list. Each
request waits for a matching command ID, generation, SOP/frame and full view
acknowledgement before the next request. Every speech beat follows all its
associated actions, with another approval check immediately before speech.
Render timeout (5 seconds), mismatched acknowledgement, unavailable identity,
revoked approval or speech failure stops the queue. A 30-second speech deadline
also stops it. No timeout advances to another finding.

A new hold, Escape or manual viewer interaction aborts planning/transcription,
cancels the pending view, stops audio and increments the generation. Stale
promises, acknowledgements and audio completions cannot release later speech.
Answers retain the approval IDs and spoken command beats used to produce them;
replaying an answer cannot silently adopt a subsequently edited finding.

The existing planner's first-action alias remains compatible. The held tutor
requests only supported commands and rejects an entire unsupported plan instead
of dropping a failed action. Old `play_guide` and authored sketch actions are not
offered to this planner: their unacknowledged execution path has been removed.
Guided teaching now uses the same approved command queue. Manual browsing and
existing editor/replay behavior remain covered by their regression suites.

Tests: `lib/tutor/{holdToTalk,commands,orchestrator,planner}.test.ts` and
`e2e/radlearn/tutor-loop.spec.ts`. The browser test uses the real fake-device
microphone, separate mocked STT/tutor/TTS responses, real local DICOM rendering,
and a spy around the real `HTMLMediaElement.play`. It delays real render frames,
never forges a render acknowledgement. Full results are in M9_VALIDATION.md.

**live contract not verified. NO LIVE GCP CALL WAS MADE.** No provider key,
patient data, deployment, push, PR or M10 work is part of this milestone.
