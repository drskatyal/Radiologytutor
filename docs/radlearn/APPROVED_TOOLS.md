# P0-4: approved geometry and bounded navigation

Scope: the P0-4 command boundary pulled forward from M9. No hold-to-talk loop,
render acknowledgement, speech scheduling, journal, or replay implementation.
The existing complete `actions` array and first `action` alias remain intact.

## Authority and callers

`loadApprovedToolContext` receives the server's org-scoped stored case, verifies
current immutable version/hash/approval with the M2 validator, and reads DICOM
series metadata through the existing imaging transport. NumberOfFrames expands
multiframe SOPs into one-based frame identities. The inventory fingerprint and
ordering algorithm remain unchanged. After metadata I/O, production callers
re-read the case so an intervening edit/revocation cannot authorize an old ID.
Metadata outages, PHI failures, unapproved/legacy anchors and changed instance
sets grant no tool authority. No request-body catalog, count or geometry is used.

`runTeachingPlan` receives this context from `/api/tutor`; the prompt lists the
approved IDs and current inventory addresses. Gemini Live gets the catalog from
`GET /api/cases/[caseId]/approved-tools`, included only in teaching tool
instructions. Both execution paths call POST on that endpoint to validate again
after model latency. It requires a session, org ownership, a published case and
no active examination; anonymous access is 401 and active exams are 403.
Missing/invalid targets return 422. The endpoint does not call Gemini.

IDs contain case, finding, version and contentHash. A text/geometry/provenance
change or reapproval creates different IDs. A pure metadata reorder retains IDs
and resolves to the same Study/Series/SOP/frame. M2's existing approval/reorder
logging is unchanged; a tool call does not create an approval.

## Tool contract

- `point_to {anchorId}`: only a current approved anchor ID. Coordinates come from
  the approved imagePoint, normalized across the metadata pixel grid and
  projected through the current image-to-world-to-canvas transform, or its approved
  legacy normalized marker when no explicit imagePoint exists. An invalid
  explicit imagePoint cannot fall back to the marker. An unavailable projector
  or off-screen point fails closed. Existing viewport-space markers/strokes
  retain their approved coordinates; M5/M8 still own their image-space migration
  and exact camera/layout replay.
- `draw_annotation {annotationId}`: exactly one approved, explicitly located
  annotation. The catalog currently accepts finding `annotations` records with
  `studyUID`, `seriesUID`, `sopUID`, `frame` matching the finding anchor, `shape`
  (`circle`/`arrow`), normalized `from`/`to`, optional normalized `handles`, and
  an allowlisted Cornerstone `tool`. All are covered by the version contentHash.
  Legacy guide strokes with only an index are withheld; this step does not
  invent their identity or add the M5/M7 recording/editor work needed to rebind
  them. Finding creation preserves these records in the reviewed version, as
  does the existing version-edit endpoint. The renderer receives an allowlist
  of geometry fields, no model payload.
- `scroll_to {anchorId}` is preferred. Alternatively `{sliceIndex,
  seriesInstanceUID?, findingId?}` uses the current server inventory address.
  Integers must be within `[0, frameCount)` and resolve to an approved SOP/frame.
  In-range but unapproved frames are denied. With multiple series, an omitted
  series requires an unambiguous named finding. No coercion, rounding, clamping,
  nearest slice or fallback. Conflicting identity/index forms are rejected.
- Indexed `set_series` uses the same gate, so it cannot bypass scroll bounds.
  Series-only switches keep their existing allowlist and do not implicitly
  seat an old authored index. Window/zoom and the rest of M9 are out of scope.

Even exact copies of approved numbers in model point/draw arguments are rejected;
free numeric geometry, extra fields, unknown IDs and missing contexts fail closed.

The client resolves the canonical target in Cornerstone's **current** image IDs,
not the server archive offset, stored guide index, initial `imageCount`, or rail
count. Missing/duplicate/progressive-only identities and MPR cannot substitute a
slice. It checks the displayed identity after the move before drawing/pointing.
This check is not an IMAGE_RENDERED acknowledgement: M4/M9 must still implement
the specified render/clock/generation and speech-release contract.

## Tests and corrected old expectations

`lib/harness/approvedTools.test.ts` covers actual synthetic metadata, single and
multiframe bounds, strict arguments, approved annotation geometry, stale/tampered/
revoked versions, metadata failure, reorder, missing identity, both model callers,
and the shared client executor. The browser spec exercises the real local route,
local session/org boundaries, approval/edit lifecycle, and forged client inputs.
The existing exam browser leak scan now checks both GET and POST on the endpoint.

The dedicated P0-4 fix updates three previous positive caller fixtures to provide
trusted approval context and use IDs instead of a finding-only point or an
unbounded index. They still assert successful navigation, windows and **all
three actions**; the former acceptance without approval/bounds was the wrong
behavior identified by strategy §2.2 D7 / §4 M9. The planning snapshot changes
only to record the new prompt/tool request contract. No test is removed or
relaxed. Existing internal evaluator actions retain their typed numeric fields;
model parsing and the production client cannot execute that legacy geometry.

All media and accounts in these checks are synthetic. Model transport and cloud
services are mocked; the browser uses the localhost synthetic archive and JSON
store. **live contract not verified. NO LIVE GCP CALL WAS MADE.** No dependencies,
remote configuration, deployment, push, PR, merge or .github changes. The sole
provisional bucket constant remains `PROVISIONAL_GCS_BUCKET_ENV` in envSchema.
