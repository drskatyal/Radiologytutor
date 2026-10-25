# Teaching guide — demo

A recorded finding becomes a live teach script. The student viewer scrolls, windows, zooms, points, and draws the way the teacher did, while the tutor speaks. This is not a playback of the teacher's microphone.

## What was captured before

`TrackRecorder` already stored any `ViewerEvent` it was given. `CornerstoneViewer` only emitted slice, VOI, camera, invert, and series. Length / ROI / arrow strokes were snapshotted once, at save, via `getMeasurements()`. The tutor saw a one-line `readingDigest` (`read=12s · scroll · windowed`) and could not replay the gesture.

## What happens now

1. **Record.** Completing or adjusting a Length, Ellipse, Rectangle, Probe, Arrow, or Angle tool appends an `annotation` event (tool, normalized handles, slice, mm/HU when Cornerstone has them) onto the `RecordedTrack`.
2. **Script.** `buildTeachingGuide` turns that log into a consultant walk-through. Each beat says where to go, which window, what to notice, and the line to speak. A quiet gap of about a second becomes a **hold**. Author description and teaching points are spoken on the gesture they belong to (look, then measure) — this is not the one-line `readingDigest`.
3. **Teach.** In Teach mode the student session calls `playTeachingGuide` (`lib/replay.ts`) on the teacher's clock. It primes the recorded slice and window, waits for each beat's timestamp, steps the scroll through `applyEvent`, eases VOI with `setWindow` and zoom with `showState`, holds, points, and places each stroke with `applyEvent` (overlay fallback if the native tool cannot land). The beat's line is spoken with that motion. Socratic and viva do not auto-play; the model can call `play_guide`, or `zoom_to` for a single lean-in. `zoom_to` is a harness tool — the nodule eval fails a turn that never zooms.

## Demo

1. Run the app (`npm run dev`) and open **Author** on a case with a real stack (annotation tools need a study; the synthetic sample may disable them).
2. Record one finding. While narrating:
   - scroll a few slices
   - change window/level (for example lung → soft tissue)
   - zoom in
   - draw a **Length** or **Arrow** on the finding
3. Save. Author **Replay** (QA) should ink the stroke back in time with the track. That path is still `startReplay` — a capture check, not the learner product.
4. Open the case as a student in **Teach**. The viewer should:
   - land on the recorded start slice and window
   - scroll to the slice you stopped on
   - ease the window, zoom in, and hold where you held
   - point, then draw the stroke, speaking the line for that beat
5. Ask a question (hold the mic or type). The tour pauses. In **Socratic**, the script stays hidden until you attempt an answer or ask to be shown; the tutor can then call `play_guide`.
6. Optional: one continuous take (**Speak once**) segments into findings. Each proposal shows a teach-beat count. Saving runs the same merge, so each finding carries its own script.

Findings saved before this change still teach: if they have a `track`, the guide is rebuilt on the student session from that track plus the current description. Strokes appear only when the track contains `annotation` events, so re-record a finding once to capture calipers.
