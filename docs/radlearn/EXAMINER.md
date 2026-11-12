# M10 — examiner attempt contract

An exam opens on the neutral series midpoint, using the M1 learner projection. It
receives no authored finding location, label, diagnosis, rubric or teaching pack.
The response panel supports a report, a held microphone recording with a reviewed
transcript, or a click on the currently rendered original-stack image. Keyboard
users can select the image centre. Point answers contain SOP UID, frame and image
pixels from the render acknowledgement, never a guessed slice index. The server
also validates identity, frame and pixel bounds against the case's real metadata.

Each attempt pins an immutable approved-current key on the server. Answers, hints,
retries, assistance flags and timestamps persist in the attempt. An atomic revision
check rejects competing writes. An optional request ID makes transport retries
idempotent; reusing it with changed content fails. The legacy report endpoint uses
the same service. A browser reload resumes the attempt named in the URL, including
a completed attempt; it does not silently start a new one.

The model receives learner text only for optional clause structuring. Its output
is retained privately after the existing verbatim/negation filter. Deterministic
scoring uses canonical clauses from the submitted text, so model omissions,
partitioning, invented facts and proposed scores cannot change a grade. The server
uses the latest point and latest report/transcript in the current try; either may
satisfy an item. It never takes the best score from a previous try. Explicit
assistance and recorded hints carry forward to subsequent answers. Scores include
the pinned rubric version, per-item matches, assistance, hint and retry counts.

Active receipts contain only the learner's own answers and neutral activity. No
per-answer score or reference evidence is sent before close. Closing requires an
answer in the current try. Closed attempts are immutable, except that an identical
network replay returns the saved receipt. Reference content is fetched separately
through the owned attempt's `/reveal` endpoint after close. An active exam anywhere
in the same user's organization blocks revealing an earlier reference key.

Exam speech is exclusively fixed text and style from `examinerPromptPack()`.
`/speech` accepts only `opening` or an already-recorded `hint`, never arbitrary text,
a teacher voice ID or a teaching pack. This deliberately neutral examiner channel
uses the existing Gemini adapter; authored narration still keeps ElevenLabs primary.
It has no tools, Search grounding or direct Live socket. `/transcribe` accepts only
review-confirmed learner audio, checks the transcript for PHI, and does not submit
it as an answer. The UI requires a second review of the editable transcript.
Starting a hold interrupts speech; Escape, blur, hiding or changing modes cancels
capture/pending audio. Both audio endpoints recheck that the attempt remains open
after the provider request. Missing model configuration is an explicit error with
text entry still available; there is no silent model or speech fallback.

## Local validation boundary

`e2e/radlearn/exam-flow.spec.ts` exercises real local persistence, authentication,
DICOM rendering/coordinates, revisions, scoring, close/reveal and browser recording.
The standard radlearn run mocks the two exam audio HTTP responses explicitly. The
additional `playwright.exam.config.ts` runs those real server routes and adapters
with `e2e/support/examTransportMock.mjs` as a Node preload. That harness accepts only
localhost or the mocked Gemini hostname; every other external fetch fails. Its
fixed synthetic transport marker is not a credential. It records synthetic request
bodies only, never headers, cookies, tokens or keys. The leak scan covers HTML, RSC,
JSON, browser API bodies, socket frames (none expected), and those model bodies.
The model deliberately offers an invented fact and score; neither reaches a receipt.

**Gemini: NOT VERIFIED LIVE; live contract not verified. NO LIVE GCP CALL WAS MADE.**
All DICOM, microphone audio and cases are synthetic. No new dependency, deployment,
Actions run, PR, merge or push is part of M10.
