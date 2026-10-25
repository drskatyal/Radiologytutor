# Teaching guide — demo

A recorded finding becomes a live teach script. The student viewer scrolls, windows, zooms, points, and draws the way the teacher did, while the tutor speaks. This is not a playback of the teacher's microphone.

## What was captured before

`TrackRecorder` already stored any `ViewerEvent` it was given. `CornerstoneViewer` only emitted slice, VOI, camera, invert, and series. Length / ROI / arrow strokes were snapshotted once, at save, via `getMeasurements()`. The tutor saw a one-line `readingDigest` (`read=12s · scroll · windowed`) and could not replay the gesture.

## What happens now

1. **Record.** Completing or adjusting a Length, Ellipse, Rectangle, Probe, Arrow, or Angle tool appends an `annotation` event (tool, normalized handles, slice, mm/HU when Cornerstone has them) onto the `RecordedTrack`.
2. **Script.** On save, the mic is transcribed (`/api/transcribe-narration`). Sentence spans are stored on `track.narration`. Times are the model's estimate when the segments are ordered and inside the take; otherwise the verbatim transcript is split by word count across the take (a constant speech rate, not a forced aligner — pauses and filler are not detected). `buildTeachingGuide` does not replay the dense log. Sparse anchors are the truth: the committed slice, window, lean-in (only a zoom that stays in), point, and final stroke. The dense log only times those acts, then the clock is forced into order so a fumble is not what the registrar sees. Beats are **orient → search → lean-in → commit → pearl**. Early beats are look-cues. The pearl names the finding from the description, teaching points, and any transcript line that overlaps that text. Author QA still uses `startReplay` on the dense tape.
3. **Teach.** In Teach mode the student session calls `playTeachingGuide` (`lib/replay.ts`) on that cleaned clock. It primes the recorded approach, then moves to the money slice, window, zoom, point, and stroke. Each beat's say line is spoken with **Gemini TTS in an attending voice** (`persona: "attending"`), not the teacher's microphone and not the ElevenLabs clone. A blank say line does not call TTS. If TTS rejects, later beats still play. Socratic and viva do not auto-play; the model can call `play_guide`. A tool-only reply with nothing to say does not stall the tour: #19 fills a drive-first line when it can, and an empty clip advances. `zoom_to` is a harness tool — the nodule eval fails a turn that never zooms. A `play_guide` with no model text is scored on the guide's own say lines; text with no tools still fails.

## Demo

1. Run the app (`npm run dev`) and open **Author** on a case with a real stack (annotation tools need a study; the synthetic sample may disable them).
2. Record one finding. While narrating:
   - scroll a few slices
   - change window/level (for example lung → soft tissue)
   - zoom in
   - draw a **Length** or **Arrow** on the finding
3. Save. Author **Replay** (QA) should ink the stroke back in time with the track. That path is still `startReplay` — a capture check, not the learner product.
4. Open the case as a student in **Teach**. The viewer should:
   - open on the recorded approach, then move once to the slice, window, and point you committed (a zoom that you backed out of is not replayed)
   - speak orient, then the window, then the lean-in, then “look here”, then the finding — Gemini attending voice, timed with those moves
   - draw the final stroke with the commit, not every fumble in the log
5. Ask a question (hold the mic or type). The tour pauses. In **Socratic**, the script stays hidden until you attempt an answer or ask to be shown; the tutor can then call `play_guide`.
6. Optional: one continuous take (**Speak once**) segments into findings. Each proposal shows a teach-beat count. Saving runs the same merge, so each finding carries its own script.

Findings saved before this change still teach: if they have a `track`, the guide is rebuilt on the student session from that track plus the current description. Strokes appear only when the track contains `annotation` events, so re-record a finding once to capture calipers.
