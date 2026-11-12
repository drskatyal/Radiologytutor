# M4: retained capture and render confirmation

The studio records one CT viewport on a shared `performance.now()` clock. The
session UUID exists before permission is requested. `TrackRecorder` supplies
2-second audio and viewport-canvas video chunks; `JournalRecorder` retains those
chunks and the event journal. The full tab is never captured.

`CornerstoneControls.onRendered` publishes only from the target viewport's real
`IMAGE_RENDERED` event. Its snapshot reads the displayed image ID, not a requested
index, and includes Study/Series/SOP/frame, viewport/layout, DICOM-linear WW/WC,
invert, zoom, pan, rotation, flips, camera orientation and increasing renderSeq.
`requestView` resolves only on a subsequent matching render, with the explicit
tolerances in `lib/journal/match.ts`. An operation queue settling is not an ack.
Superseded or timed-out requests fail with a typed error. MPR and unavailable
layouts fail closed. Restoring a capture in a new tab explicitly addresses the
new pane ID while retaining the recorded image and view values.

Opening a progressive stack preserves the actual first SOP/frame when the full
stack arrives in a different order. Missing and ambiguous identities fail
closed, including the CDN path. Multiframe image IDs distinguish one-based
frames. This change does not introduce an anatomical sorting algorithm.

Clicks during capture retain a marker UUID, the rendered snapshot and image-pixel
coordinates, derived through the actual viewport transform and checked against
the currently rendered view. Input events remain intent, separate from render
evidence. Native annotation and measurement events are retained but their
geometry/calibration is marked unresolved; M5 supplies the shared calibrated
anchor resolver and marker-to-finding reconciliation. Silent capture still has
the existing one-finding notes behavior.

## Durability and recovery

IndexedDB version 2 adds `captures` and `captureChunks`. Each checksum-addressed
chunk and its manifest update commit in one transaction before HTTP upload.
Capture writes fail visibly; they do not use the old annotation store's
fail-soft helpers. Chunks remain available after successful sync as well as
failure. Recovery is scoped to the case and organization; server authorization
is checked independently on every request.

The author-only chunk PUT endpoint validates SHA-256, byte length, sequence,
stream, MIME and timing. Identical bytes and metadata return the same receipt;
reuse of a sequence with different bytes or metadata returns 409. Receipts are
atomic case-store mutations. Object bytes use `lib/durableStore.ts`: local disk
for development, the existing private GCS/ADC seam for production. Logical
conflicts cannot replace an acknowledged object. Concurrent rejected uploads
may leave an unreferenced content-addressed object; no cleanup of remote objects
is performed by this work.

Manifest GET lists server acknowledgements. Recovery compares these with local
checksums and sends only missing chunks, including after a lost HTTP response.
Completion checks every stored object's digest, the complete global chunk
sequence, journal sequence/timing, media offsets and at least one confirmed
render. The older capture-save endpoint cannot overwrite a durable manifest,
journal or offsets with client data. Corruption, a missing chunk, storage denial
or incomplete evidence prevents completion and leaves retained data in place.

After a tab dies, recovery closes the retained part of that take with an explicit
`page_interrupted` entry. The unretained tail is unknown; the app does not claim
to recover samples that never reached IndexedDB. All acknowledged data and the
retained journal prefix survive. Continued recording starts a new take and clock.
No wall-clock guess is spliced into an old monotonic timeline.

## Media timing and review

The UI stays **starting** until a non-empty microphone sample chunk arrives.
Permission failure produces an actionable message and explicitly silent viewer
capture. Stopping is idempotent, releases device tracks and permits a second
start with a new UUID. Permission delay, MediaRecorder start, pause/resume,
delivery gaps, visibility loss and interruption are journal discontinuities.

Media start offsets use the MediaRecorder start event on the same monotonic
clock. This is marked estimated: it is not a hardware sample timestamp.
Chunk delivery more than 500 ms beyond the 2-second timeslice produces a
`media_delivery_gap`; that means delayed delivery, not proof that encoded audio
samples were lost. M8 must use these records for alignment and verify ≤100 ms
drift against the synthetic cues. M4 does not claim that timed replay tolerance.
`sliceTrack` preserves the full start snapshot and signed child media offsets.

New media has all PHI review flags false. The author must review images, audio
and viewport video and explicitly save that review before model processing.
This is human review, not OCR or automatic speech PHI detection. The Files route
accepts a case/session identity, assembles checksum-verified video on the server,
requires a complete reviewed manifest, then binds the returned URI to that
session. The durable structuring path reads retained audio and that bound URI;
replacement browser audio/video/stills cannot inherit an earlier review. Stills
outside the retained manifest are omitted on this path. M6 extraction remains
deferred.

## Local evidence and limits

Unit tests cover render tolerances and timeout/cancellation, image-pixel identity,
delayed/denied mic and retry, a shared clock, delivery discontinuities, durable
write ordering, lost acknowledgements, recovery, checksum/sequence conflicts,
completion gates, tenant boundaries and PHI guards. GCS transport/ADC and Gemini
are mocked. Browser tests use real local authentication, Next routes, IndexedDB,
Cornerstone pixels and canvas video, with the synthetic tone WAV as a fake mic.
Artificial render delays postpone real animation frames, never forge render
events. The archive suite still checks the existing viewer paths.

**NO LIVE GCP CALL WAS MADE. Gemini live contract not verified.** No new
dependencies, remote scripts, push, PR, merge, Actions change or deployment.
See the status file and committed M4 evidence for exact command results.
Full journal replay/audio gating, evidence extraction, calibrated multi-marker
materialization and finding approval UI remain their assigned later milestones.
