# M7 finding review

The case editor opens Approval review with the existing studio viewer beside
versioned finding cards. The recording page shows the same cards after draft
extraction. Sequence editing remains available. Approval counts come from fresh
server verification, not marker/text completeness. Publishing requires all
findings to be approved in the UI; tutor/exam retrieval continues to enforce
current approval on the server.

Each Jump requests the recorded Study/Series/SOP UID, one-based frame, viewport,
layout, window, camera, orientation and invert. Only a matching real renderer
acknowledgement displays **Rendered ✓**; changing the view removes that notice.
There is no index fallback. Missing identity disables Jump and approval;
missing image data reports **Image not found: rebind**. The archive renderer now
keeps its coordinator across series switches in the same rail, rather than
cancelling the request when the selected source changes. A different rail or
archive still invalidates the renderer. Recorded-pan application also handles
Cornerstone's one-pixel setter deadband while retaining the 0.5-pixel render
tolerance. No replay scheduler was introduced.

Evidence buttons open authenticated retained audio/video and seek to capture
`tStart` minus that stream's recorded offset. Native controls permit inspection;
no media plays automatically. Unknown times are disabled, estimated windows
remain labelled, and unavailable media has an explicit error. This is evidence
inspection, not M8 synchronised journal/media replay.

Label, description, teaching points and three media PHI review flags save as a
new version using expected version and content hash. Conflicts preserve local
edits and offer explicit discard/reload. Unsaved edits warn before leaving;
keyboard focus and disabled reasons use the shared studio components. A version
history shows immutable field differences. Annotation and measurement lists
show units, named frame and calibration provenance.

Rebind is an explicit expert action: position the finding at the viewport
centre, then capture the current acknowledged image and image-pixel point. The
server verifies case membership, exact SOP/frame and pixel bounds against fresh
metadata; it rebuilds geometry and spacing provenance from that metadata, not
client values. Rebind replaces the current geometry rather than attaching old
measurements to another image. Prior geometry remains in version history. An
uncertain extraction requires an explanatory review note; resolved issue codes,
reviewer, source hash/version and time are recorded in `expertReview` and hashed.
Original proposals, evidence timestamps and earlier versions remain retained.

The author-only review endpoint checks the latest version while holding the
existing case mutation lock/CAS. It withholds approval if the content, instance
set, ordering algorithm, PHI review or anchor is stale. Pure archive reorder
preserves approval and records revalidation. The existing approval endpoint
remains the authority: the UI sends the exact saved version and hash. No
migration or grandfathering of published cases is added. Previously approved
M2 records with complete identity but no full viewer snapshot can retain their
existing approval; new UI approval requires rebind when the full view is absent.

Routes are org-scoped and private/no-store. Retained media can be inspected by
the author before its PHI checkbox is checked; model upload still requires the
separate retained-media review gate. Anonymous requests return 401. No new
package, environment setting, model adapter or remote service was introduced.

Tests cover exact multiframe jumps, delayed real render, reorder, incomplete and
missing SOPs, explicit rebind, keyboard approval, stale drafts, diffs, evidence
seek and metadata-I/O races. The M6 browser test also carries its real local
capture and mocked extraction into Jump and approval on the recording surface.
M8 timed replay and M9 tutor sequencing/hold-to-talk remain deferred per §4;
§2's older M7 labels for those features do not change the ordered milestone map.

**NO LIVE GCP CALL WAS MADE. NOT VERIFIED LIVE — live contract not verified.**
All DICOM/media fixtures are synthetic; model/transport calls and fonts are
mocked locally. Clinical quality and deployed behavior are not verified here.
