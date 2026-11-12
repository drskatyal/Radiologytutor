# M8 exact retained-take replay

Author review now offers **Replay approved take** after approval of the current
finding version. It retrieves the complete original take through an author-only,
organization-scoped endpoint and checks fresh approval, version/content hash,
retained journal, complete manifest and media PHI review. Text edits do not
rewrite the original capture. The latest-take replay in the recorder uses the
same journal player. Legacy tracks without journals keep their existing casual
preview; they cannot enter the approved exact-replay surface.

`lib/replay/player.ts` primes the complete first snapshot, then calls
`requestView` for every render/layout entry at its recorded timestamp. The
initial archive offset and legacy display index never select an image. It
checks command ID, generation and the existing full-view acknowledgement
contract (identity, frame, window, camera, orientation, layout, inversion).
The clock and audio stop at each render boundary. They resume only after the
matching actual Cornerstone render. A missing image, timeout, mismatched ack,
unsupported geometry or manual view change stops replay with a visible reason.
Stop, unmount and backgrounding cancel pending work; a late ack cannot resume it.

Recorded audio is decoded locally with Web Audio. Its sample scheduling and the
replay timeline use `AudioContext.currentTime`. `audioOffsetMs` places the first
sample on the capture clock; source nodes stop at the next render boundary even
if the browser's UI thread stalls. Known pause/resume intervals insert silence.
Unknown delivery gaps, interrupted recovery tails, missing offsets, truncated
audio beyond 100 ms, suspended audio and decode/load failures fail closed.
No blocked-audio fallback silently completes a voiced take. Partial audio
excerpts without the earlier journal are rejected: replay the complete retained
take to account for all earlier gaps. Recorder offsets still carry M4's explicit
MediaRecorder-start estimate; synthetic timing success is not proof of hardware
microphone latency in production.

Markers and measurement/annotation handles are resolved from their named
SOP/frame and original image pixels. Cornerstone projects those pixels into the
confirmed viewport. Recorded PixelSpacing, ImagerPixelSpacing or uncalibrated
provenance and patient coordinates are preserved. Other images hide the overlay;
returning to the named image restores it. No assumed 1 mm spacing or viewport
percentage becomes image geometry. Unsupported/incomplete handles fail closed.

A replay receipt stores the pinned finding version/hash, capture ID, each
confirmed snapshot and wait time, and any miss. The server validates identities,
sequence/timestamps and complete coverage before accepting a successful receipt.
These are **client diagnostic receipts**, not trusted new approvals. Historical
receipts remain attached to their original version when an expert edits a
finding. The exam projection does not expose these records or retained media.

## Local acceptance

- `lib/replay/{player,audio,geometry,server}.test.ts`: delayed/missing/mismatched
  acknowledgements, cancellation, manual override, offsets, explicit/unknown
  gaps, sample scheduling, original-pixel/patient geometry, organization and
  approval gates, immutable-version receipt checks.
- `e2e/radlearn/replay.spec.ts`: one real local CT capture, one retained marker,
  chunk sync, media review, one injected-model extraction job, expert text edit,
  new-version approval, exact replay of every real recorded render and marker.
- `replay-clock.spec.ts`: an analyser measures actual decoded synthetic-beep
  onsets against the replay clock with a 350 ms audio offset; both cue drifts
  must be ≤100 ms. A separate retained gap fails before playback.
- `replay-delay.spec.ts`: delay real renderer animation callbacks (no forged
  IMAGE_RENDERED) to verify holds, resume and timeout with a saved miss.
- `replay-geometry.spec.ts`: exact view/first-frame timing despite a deliberately
  wrong index hint, real projected pixels, patient mm and spacing provenance.
- Extended `replay-missing-instance.spec.ts`: a missing journal SOP stops at that
  event, retains the previous confirmed image and never advances to a substitute.

Synthetic media and localhost archive only. Real Cornerstone, Web Audio,
MediaRecorder/IndexedDB, authenticated routes, local object storage and case
version/approval writes. Gemini output is injected only at the existing test
seam; no production bypass. **NO LIVE GCP CALL WAS MADE. NOT VERIFIED LIVE —
live contract not verified.** No new dependencies or environment names.
No M9 tutor sequencing, hold-to-talk, model call, deployment, PR or push.
