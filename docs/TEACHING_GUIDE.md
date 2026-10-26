# Teaching guide — demo

A recorded finding becomes a live teach script. The student viewer scrolls, windows, zooms, points, and draws the way the teacher did, while the tutor speaks. This is not a playback of the teacher's microphone.

## What was captured before

`TrackRecorder` already stored any `ViewerEvent` it was given. `CornerstoneViewer` only emitted slice, VOI, camera, invert, and series. Length / ROI / arrow strokes were snapshotted once, at save, via `getMeasurements()`. The tutor saw a one-line `readingDigest` (`read=12s · scroll · windowed`) and could not replay the gesture.

## What happens now

1. **Record.** Completing or adjusting a Length, Ellipse, Rectangle, Probe, Arrow, or Angle tool appends an `annotation` event (tool, normalized handles, slice, mm/HU when Cornerstone has them) onto the `RecordedTrack`.
2. **Script.** On save, the mic is transcribed (`/api/transcribe-narration`). Sentence spans are stored on `track.narration`. Times are the model's estimate when the segments are ordered and inside the take; otherwise the verbatim transcript is split by word count across the take (a constant speech rate, not a forced aligner — pauses and filler are not detected). `buildTeachingGuide` does not replay the dense log. Sparse anchors are the truth: the committed slice, window, lean-in (only a zoom that stays in), point, and final stroke. The dense log only times those acts, then the clock is forced into order so a fumble is not what the registrar sees. Beats are **orient → search → lean-in → commit → pearl**. Early beats are look-cues. The pearl names the finding from the description, teaching points, and any transcript line that overlaps that text. Author QA still uses `startReplay` on the dense tape.
3. **Teach.** In Teach mode the student session calls `playTeachingGuide` (`lib/replay.ts`) on that cleaned clock. It primes the recorded window, then — on the search act, or on orient when the script has no search beat — **step-scrolls** from the current slice to the money slice over about two seconds. Lean-in, commit, and pearl then land on that exact slice (zoom, point, stroke) without another walk. A scripted pause longer than a few seconds is capped to an attending hold (at most 3s); time already spent speaking counts toward it. Each beat's say line is spoken with **Gemini TTS in an attending voice** (`persona: "attending"`), not the teacher's microphone and not the ElevenLabs clone. A blank say line does not call TTS. If TTS rejects, or audio never starts, later beats still play — a hung clip cannot hold Speaking forever. Socratic and viva do not auto-play; the model can call `play_guide`. A tool-only reply with nothing to say does not stall the tour: #19 fills a drive-first line when it can, and an empty clip advances. `zoom_to` is a harness tool — the nodule eval fails a turn that never zooms. A `play_guide` with no model text is scored on the guide's own say lines; text with no tools still fails.

   If the learner is more than 8 slices from the money slice when a **commit** or **pearl** is about to play, the tour walks them onto that slice and speaks a directional line before the pointer or the name ("You're still too high — come toward the carina."). The place comes from the finding's optional landmark (author field **Level to name first**). The finding label is withheld, so the hint does not diagnose. The search act already walked to the money slice, so a learner who follows the script does not hear that line. The hint uses the same attending `narrate` callback as the other beats.

## Demo

1. Run the app (`npm run dev`) and open **Author** on a case with a real stack (annotation tools need a study; the synthetic sample may disable them).
2. Record one finding. While narrating:
   - scroll a few slices
   - change window/level (for example lung → soft tissue)
   - zoom in
   - draw a **Length** or **Arrow** on the finding
3. Save. Author **Replay** (QA) should ink the stroke back in time with the track. That path is still `startReplay` — a capture check, not the learner product.
4. Open the case as a student in **Teach**. The viewer should:
   - open on the current slice, then scroll through the stack toward the slice you committed while the search line plays (not one jump), then window, lean in, and point (a zoom that you backed out of is not replayed)
   - speak orient, then the window, then the lean-in, then “look here”, then the finding — Gemini attending voice, timed with those moves
   - draw the final stroke with the commit, not every fumble in the log
5. Ask a question (hold the mic or type). The tour pauses. In **Socratic**, the script stays hidden until you attempt an answer or ask to be shown; the tutor can then call `play_guide`.
6. Optional: one continuous take (**Speak once**) segments into findings. Each proposal shows a teach-beat count. Saving runs the same merge, so each finding carries its own script.

Findings saved before this change still teach: if they have a `track`, the guide is rebuilt on the student session from that track plus the current description. Strokes appear only when the track contains `annotation` events, so re-record a finding once to capture calipers.

## Demo guides vs teacher-recorded guides

Precedence in `resolveTeachingGuide`, highest first:

1. **RecordedTrack.** Rebuild with `buildTeachingGuide` from the track plus the current label, description, teaching points, and `track.narration`. A stored `teachingGuide` is ignored — including the LIDC demo script, even if that object is still sitting on the finding. Studio save writes both the track and the rebuilt guide (`withRecordedTeaching`) after `/api/transcribe-narration`. Teach plays the rebuild, so a later prose edit is what the registrar hears.
2. **Stored teachingGuide.** Demo fallback, only when the finding has no teacher track (`findingHasTeacherTrack` is false).
3. **Nothing.** No autoplay script. The live tutor can still speak.

A **teacher-recorded guide** starts as a `RecordedTrack` (the capture clock). Author Replay still plays the dense track. Learners do not hear the microphone file. `playTeachingGuide` is the same clock as the demo: sparse anchors, acts **orient → search (scroll-walk) → lean-in → commit → pearl**. The money-slice scroll is authored on orient and walked during the search line (about two seconds, sampled), then the window, lean-in, point, and pearl land on that slice. Say lines are the builder's look-cues plus any transcript span that falls in that beat and does not name the finding; the pearl is the authored description, teaching points, and the transcript line that overlaps that text. Each non-blank line goes to Gemini TTS in the attending voice (`persona: "attending"`).

A **demo guide** is a `TeachingGuide` stored on the finding when no teacher track exists yet. It is `buildTeachingGuide` run on the finding's sparse anchors: the committed slice, the authored window, a 2.2× lean-in, and the marker. Say lines are that builder's acts (look-cues, then a pearl from the description and teaching points). Teach plays it with `playTeachingGuide` and speaks each line with Gemini TTS in the attending voice (`persona: "attending"`). A blank line does not call TTS. This is not a second speech writer and not a microphone tape.

Those lines are the narration. `tutorSpeechPlan` fills a blank live-tutor answer, and it also speaks a motion guide that has no `say` lines. A demo guide has a line on every beat, so that fallback does not replace the script. The learner re-seat is the same clock: more than 8 slices off the committed slice at commit or pearl, and Teach scrolls there and speaks the directional line before the name. A learner who stays with orient does not hear it.

`case-lidc-nodule-search` ships that script. `npm run import:cases` attaches it after slice indices are scaled to the imported stack, and only for findings that do not already have a teacher track. `npm run seed:lidc-teach` does the same for a case already in the store, or writes the catalog case (public 65-slice stack, findings on slices 34, 49, and 64) when the case is missing. Each finding is the five acts `buildTeachingGuide` emits: orient, search, lean-in, commit, pearl.

The first human recording stores a track. From then on the track wins, and the demo script steps aside.

`fixtures/recordings/lidc-finding-1.json` is a checked-in take for LIDC finding 1 (scroll, lung window, 2.4× lean-in, point, plus a timed transcript). `lidc-finding-1.wav` is a silent WAV so the transcribe request body is real audio; the transcript is the STT stand-in. `npm run eval:record-guide` runs that body through `narrationRequestFromBody` and `publishNarrationTake` (the route's post-STT step), saves with `withRecordedTeaching`, plays the guide, and exits 0 only when the demo lines are gone, the search act scroll-walks, and `spoken_beat` plus drive-first (`look_with_drive`) pass. No microphone and no Gemini key. The published seed case stays on the demo guide until a take is saved.
