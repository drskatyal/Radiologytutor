# M6 retained extraction contract

The capture journal is authoritative for identity, timing and geometry. Gemini
proposes prose, source classification, rough evidence windows, marker IDs and
confidence. `lib/extract/prompt.ts` is the single retained-extraction prompt;
`schema.ts` supplies its JSON schema and the stricter runtime allowlist.

A completed capture must have its pixels, audio and screen explicitly reviewed.
The server rereads retained media and verifies checksums; client replacements,
case diagnoses, rubrics, answer keys and arbitrary journal payloads are excluded.
Clock lines contain sequence/time, an opaque image label, WW/WC and marker or
annotation IDs. No Study/Series/SOP UID, frame or coordinates reach the model in
that clock. Small media is inline; media above the cumulative 12 MiB inline budget
uses the existing server Files adapter. Both paths remain subject to media review.
No Search grounding or viewer tools are enabled.

`run.ts` persists jobs on the existing org-scoped case store, through
`lib/cases.ts` and its JSON-lock/Mongo-CAS mutation seam. Identity is SHA-256 of
canonical `{manifestHash, extractorVersion, promptVersion, modelId}`, where
manifestHash is SHA-256 of the canonical completed/reviewed manifest. The actual
request uses that frozen model ID and records server-observed request metadata.
There is no alternate-model fallback.

The first POST claims a 15-minute lease and awaits extraction. Concurrent POSTs
return the running job. Completed retries return the same stored result; failed
or expired jobs need explicit `retry: true`, keeping the same identity. A lease
token fences an old worker after recovery. This is request-driven work, not an
unreliable detached background task; a killed request can be reclaimed after
lease expiry. Failed jobs expose fixed error codes, never provider bodies or raw
model output. Each capture retains at most 32 job identities.

Unknown response fields, including invented identities, geometry, measurements
and patient attributes, are discarded. The audit records only fixed categories,
locations and counts, not unknown field names or values. PHI in allowed prose
fails closed. Invalid/missing/reversed/outside/overlapping intervals retain their
original values (null for unknown), with estimated/unresolved evidence. They are
never spread proportionally across the recording. Discontinuities, missing or
foreign journal references, ambiguous marker windows, missing media source and
confidence below 0.8 also block approval until an expert resolves the evidence.

M5's resolver supplies named SOP/frame, image pixels, patient geometry and view
state from matching render acknowledgements. A contradictory event renderSeq
fails closed. Native measurement geometry comes from the full journal, including
later annotation edits/removals; only referenced retained measurements are
attached. Measurements on a different image require explicit grouped anchors.
No model-generated numeric geometry becomes authoritative.

Each retained marker yields a candidate even if the model omits it. Explicit
M5 group/omit decisions are validated and frozen with the first job. A retry
with different decisions returns 409 rather than silently changing a stored
result. The caller must restore that marker plan; subsequent expert draft
editing/reconciliation belongs to M7. Unmatched model prose is retained as an
unresolved draft, not assigned a nearby image. All proposals and evidence remain
available to the author in the job record.

`POST /api/cases/:caseId/capture-sessions/:sessionId/extract` accepts
`{action:"extract", retry?, markerDecisions?}` or `{action:"commit", jobId}`.
`GET` returns status/drafts, optionally by `?jobId=...`. Both require an author
in the owning org, before object or provider I/O; responses are private/no-store.
Unknown request fields are rejected. Running is 202, version conflict is 409,
PHI review failure is 422, provider/unconfigured failure is 503.

Commit calls M2 `createVersion` with the expected version frozen before model
I/O. Expected version zero is a server-only creation operation; the public edit
endpoint still requires an existing version. A per-draft source receipt is
written atomically on the immutable finding version. Replaying a commit after
losing its response therefore returns that receipt, even if a later expert
version exists. Concurrent commits cannot duplicate identities. An intervening
edit without a receipt conflicts; it is never overwritten. A partial commit can
be retried safely. The job records exact version/hash receipts and never
replaces the findings array. All new versions need review; extraction issues,
evidence and provenance are included in contentHash.

The existing Process control now uses the retained job and commit routes. It
keeps the capture on errors and reloads saved drafts after commit. The older
`structure-session` endpoint rejects retained captures with 409 to prevent an
untracked second extraction; it remains for legacy non-journal recordings.
Manual notes and M5 marker reconciliation remain available. Existing studio
readiness copy measures legacy content completeness, not server approval; all
extracted versions remain needs_review. No M7 approval UI,
M8 timed replay or M9 tutor queue is implemented here.

## Local evidence boundary

`lib/extract/{prompt,materialize,run,client}.test.ts` exercises allowlists,
request construction, interval uncertainty, geometry/measurement resolution,
lease recovery, concurrent requests/commits, version conflicts and lost-response
retries. Storage and serialization are real local JSON. Model and Files API
responses are injected mocks; no production mock switch was added. Existing
store tests continue exercising the Mongo CAS transport mock; no Mongo service
was contacted for this milestone.

`e2e/radlearn/extraction.spec.ts` records two markers in the real local viewer
with synthetic CT, canvas video and the fake synthetic microphone. A guarded
local fixture invokes the same persisted runner with mocked Gemini. The browser
then exercises the real authenticated GET/POST and commit routes, loses a real
commit response, edits through the version API, and retries. It asserts exactly
two findings and preservation of the later edit. Anonymous requests, PHI review,
client replacement rejection and the legacy route guard are also checked.

**NOT VERIFIED LIVE — live contract not verified.** Provider acceptance, model
quality and production latency are not established by these tests.
**NO LIVE GCP CALL WAS MADE.** No new dependency, deployment, push, PR or merge.
The first full acceptance target remains one CT series, one take, one finding
through capture, extract, expert edit/approval and exact replay; later milestone
acceptance is not claimed by M6.
