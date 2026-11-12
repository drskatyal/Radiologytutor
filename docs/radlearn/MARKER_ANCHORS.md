# M5: retained markers and calibrated anchors

A completed author take produces one draft per retained marker by default. The
silent notes path needs no microphone or model. The notes, segmented and server
AI materializers all reconcile the same journal identities; preview and Jump use
that same resolver. Model prose/windows can suggest text for a marker. They
cannot supply its SOP, frame, pixels, patient coordinates or measurements.
Unmarked cursor midpoints remain suggestions with unresolved anchors.

`lib/anchors/resolve.ts` returns the named render snapshot, original image pixel
point, patient point (when calibrated), spacing provenance and journal sequence
references. A preceding matching render is required. Missing IDs, removed
markers, out-of-image geometry and unconfirmed snapshots cannot resolve.
Index-only history remains incomplete. MPR remains unresolved; reconstruction
plane/slab/frame-of-reference capture and exact MPR replay are out of scope.

`reconcile.ts` folds append-only marker add/move/remove/undo entries. Each retained
marker is assigned once. The author can explicitly group adjacent candidates or
omit them; these decisions, their marker IDs and reasons persist on the capture
session, and group membership/full anchor evidence persists in immutable finding
content. A group with an unresolved member cannot become approvable. All-omitted
takes retain the omission record without creating a finding. Retry identities
remain tied to the take/marker; this does not implement M6 extraction jobs.

During capture, the pending marker list exposes Remove and Undo last marker
(Alt+Z). Alt+X retains hold-to-record; shortcuts ignore text editing, IME and
repeats. Releasing an unrelated X/Alt key does not stop a button-started take.
After a silent take, every candidate has its own label and Jump. Jump waits for
`requestView` and reports confirmation only after the matching render. Grouping
and omission are reversible before saving; saving requires every remaining
candidate to have a label. These are draft controls, not the M7 approval UI.

The older single-finding editor/dialog also resolves its retained marker through
the same helper. A multi-marker take cannot silently collapse there: the author
must explicitly check “Group all … markers as views of this one finding”, or use
Speak once for separate candidates. The grouped IDs and complete anchors persist
on the finding. This guard runs before any optional media request. A silent
journal counts as a take even if it contains no legacy input events.

## Geometry and measurements

The viewer keeps a geometry-only allowlist from original DICOM JSON metadata,
keyed by the exact image ID. It does not infer calibration from Cornerstone's
fallback spacing. PixelSpacing takes precedence; ImagerPixelSpacing is used only
when PixelSpacing is absent. Missing, zero, negative or malformed spacing is
uncalibrated, never 1 mm. Patient points and mm lengths are null/absent then.
DICOM spacing order is row, column; x uses column spacing and y uses row spacing.
Oblique direction cosines and original ImagePositionPatient define patient mm.
Multiframe uses the named frame's PlanePositionSequence; a missing per-frame
position never borrows another frame or the instance origin.

Native annotations capture original pixel handles only while their referenced
image is the currently confirmed image. The journal stores image points, patient
conversion provenance and exact SOP/frame. Debounced callbacks for another image
stay unresolved. Length is recomputed from retained calibrated geometry, not a
model or cached default-mm statistic. Other captured annotation handles remain
available in the journal; full geometry restoration/timed replay is M8.

`resolvedAnchor`, grouped anchors, geometry and reconciliation join the existing
content-hash allowlist, alongside measurements/text/view/evidence. Approval is
still per-version, server-owned and subject to M2 inventory/PHI checks. No
existing published finding is grandfathered or silently repaired.

## Evidence and limits

Unit tests: `lib/anchors/{resolve,reconcile,geometry,commit,singleEditor}.test.ts`,
`lib/studioHotkeys.test.ts`, and the recorder durability extension. T7 covers
notes/segmented/AI cardinality, explicit groups/omissions, removals/undo, retained
server materialization and retry identities. T8 covers anisotropic/oblique
round-trip within 1e-6 mm, missing/zero spacing, ImagerPixelSpacing provenance,
measurement serialization and distinct multiframe positions.

Browser: `e2e/radlearn/markers.spec.ts` uses a real Cornerstone viewer, real
IndexedDB/local authenticated routes and synthetic DICOM. Microphone denial is
mocked. Three silent markers produce three candidates with exact SOP/frame Jump
acknowledgements and three persisted draft findings. Gemini is never called;
**live contract not verified**. **NO LIVE GCP CALL WAS MADE.**

The first full vertical target remains one CT series, one take, one finding
through capture, extraction, edit/approval and exact replay. M5 completes the
marker/geometry portion only. M6 extraction, M7 approval UI and M8 timed replay
are not started. No new dependency, PR, merge, push or deployment.

Ideas re-implemented by hand: PR #130 @
`c020222daf907eb3262feb146d87b45850b56690`, teacherSketch/sketchProjection,
pendingSketchMarkers and studioHotkeys. No source branch or PR was touched.
