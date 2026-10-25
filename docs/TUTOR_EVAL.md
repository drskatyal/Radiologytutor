# Tutor eval — did it teach at the workstation?

A radiology teacher moves the scan, leans in when the finding is small, and
talks about what is now on the screen. A chatbot writes a correct paragraph
while the image sits still. This eval fails the second one, and it also fails
a drive that jumps around or names the finding before the viewport matches.

```
npm run eval:tutor
```

Exit 0 only when a text-only fake **fails** and a viewer-driving reference
**passes**. The reference is the consultant sequence, including `zoom_to`,
so it is also fidelity **TAUGHT** and world-class on this fixture. The
command does not call Gemini and needs no API key.

```
npm run eval:tutor -- --live          # also score Gemini; needs GEMINI_API_KEY
EVAL_TUTOR_LIVE=1 npm run eval:tutor  # same
npm run eval:tutor -- --json          # machine-readable summary
npm run eval:tutor -- --fixture path  # another fixture of the same shape
```

`--live` exits 1 if the live model fails the hard bar, even when the mock
contract holds. Do not put a key in the repo.

## Fixture

`fixtures/tutor-eval/apical-pneumothorax.json`

Synthetic chest CT. No pixels, no PHI, no TCIA download. The public catalog
(`lib/publicCases/catalog.ts`) is real DICOM with approximate mid-stack
anchors and no teacher track, so it cannot score order. This fixture can.

The learner opens on **slice 0, soft-tissue WW/WC 400/40**. The findings are
invisible there.

| Finding | Slice | Window | Marker | Teacher |
|---|---|---|---|---|
| Right apical pneumothorax | 8 | 1500 / -600 | (0.28, 0.22) | scroll, lung window, point. No zoom. |
| Left lower lobe nodule | 27 | 1500 / -600 | (0.70, 0.62) | scroll, lung window, **zoom 2.2×**, point |

`teachingGuide` on each beat is what a consultant would do for a registrar
who opened on the wrong slice and the wrong window:

1. Scroll to the finding.
2. Set lung windows (1500 / -600).
3. Zoom, only when the teacher zoomed (the nodule, 2.2×).
4. Point at the marker.
5. Then name the finding.

The recorded `track` is the consultant's own clock (they were already on lung
windows). The guide collapses that to one landing scroll. `t` is order, not
latency.

If a beat omits `teachingGuide`, `teachingGuideFromTrack` builds the same
sequence from the track, including `zoom_to`. `buildTeachingGuide` in
`lib/teachingGuide.ts` is the live Teach-mode script. `play_guide` expands
to that script's scroll, window, zoom, and point. The reference tutor still
emits `scroll_to`, `set_window`, `zoom_to`, and `point_to` with its own
narration. A blank `play_guide` is scored on the script's say lines.

## What “drive the viewer” means

The scorer applies the same tools the student client applies
(`lib/harness/tools.ts`, `useStudentSession.executeAction`):

| Tool | Effect |
|---|---|
| `show_finding` | Scroll, authored WW/WC, then the laser. One tool. No zoom. |
| `next_in_tour` / `prev_in_tour` | Same reveal, on the next or previous finding. |
| `set_window` | WW/WC only. Values must match the authored VOI (±20). |
| `scroll_to` | Slice only. |
| `zoom_to` / `set_zoom` | Magnification. `set_zoom` is the same effect. |
| `point_to` with a finding you are not on | Full reveal, then the laser. |
| `point_to` with raw `x_pct` / `y_pct` | Laser immediately, no window change. |
| `play_guide` | The product script (`lib/teachingGuide.ts`): one scroll to the money slice, the authored window, zoom only when the teacher leaned in, then the laser. The scorer expands that call into those effects. When the model text is blank, the guide's say lines are the narration. |

`zoom_to` is in `HARNESS_VIEWER_TOOLS`. On a beat whose guide zooms, skipping
it fails `order` and `human_sequence`. Placing it after the laser fails
`human_sequence`. There is no BLOCKED zoom hole on this fixture once the
reference emits the zoom.

Wall-clock latency is not scored. Speech and tools are paired with
`buildPerformancePlan`: action 0 rides sentence 0, and each later action
rides the next sentence. The finding's name has to sit on a sentence that
starts after the laser (and the zoom, when the guide zooms) is already up.

## Hard checks (any miss → verdict FAIL, score 0)

Headline score is 0 or 100. A decent sentence does not earn partial credit.

| Check | Fail |
|---|---|
| `text_only` | No live tool. This is the chatbot. |
| `look_with_drive` | The first spoken sentence does not carry a tool. |
| `seated_finding` | Never seated this finding, or seated a different one. |
| `order` | A later gating guide step landed strictly before an earlier one, or a gating step never happened. `zoom_to` is gating. |
| `human_sequence` | Scroll, then window, then point did not happen in that strict order. If the guide zooms, the zoom must sit strictly between the window and the laser. |
| `no_random_jump` | A scroll walks away from the target slice, moves sideways, or lands on another finding's slice. A direct jump onto the target passes. |
| `speech_on_viewport` | A sentence that names this finding starts before slice, window, laser, and (when required) zoom are already up. |
| `pointer_before_window` | The laser moved while the window was still the wrong preset. |
| `landing_slice` | Final slice is not the finding’s slice. |
| `landing_window` | Final WW/WC is not the authored VOI (±20). |
| `landing_pointer` | Pointer misses the marker. Hit radius is `DEFAULT_HIT_RADIUS` (0.08). |
| `hallucinated_window` | Any window effect in the turn is not the authored VOI, even if a later tool corrects it. |
| `narration_present` | Nothing was said. |
| `spoken_beat` | Nothing was said. A tool with no line is not a tour. Text with no tools still fails `text_only` — speech alone is not a pass. |
| `look_cue` | The first sentence does not start with look / see / watch / follow. |
| `narration_on_screen` | Speech never uses this beat’s distinctive terms. |
| `narration_ahead` | Speech names a **later** finding’s distinctive terms. |
| `narration_hygiene` | Speech contains a finding id, a `0.xx` coordinate, or a field name. |

A paragraph that describes the pneumothorax and says “look at this slice”,
with **no tools**, fails. Score 0.

## Human-teacher fidelity

The hard score asks whether the turn is a chatbot. Fidelity asks whether a
registrar was taught at the workstation.

| Beat | Consultant |
|---|---|
| Pneumothorax | Scroll off slice 0 onto slice 8 → lung window 1500/-600 → point at the apex → then say pleural line / pneumothorax. No zoom. |
| Nodule | Scroll to slice 27 → same lung window → zoom 2.2× → point at the marker → then say nodule. |

The scorecard prints this under **HUMAN-TEACHER FIDELITY**. Each phase is
`MET`, `MISSED`, `BLOCKED`, or `n/a`. A beat is taught only when every phase
is met or n/a. Zoom is `n/a` when the teacher did not zoom. Zoom is `BLOCKED`
only when the guide asks for it and `zoom_to` is missing from the registry.
That is not the state of this branch: the tool is registered, so a missing
zoom is `MISSED` and a hard fail.

`world YES` means the hard bar passed, every beat was taught, and the hole
list is empty. The reference driver does that.

Failure modes the scorecard names, and a test fails each one:

- **Frozen image.** No tool. Text-only. Score 0.
- **Random scroll.** Slice 0 → 3 → 39, then a repair onto slice 8. `no_random_jump` fails.
- **Early lecture.** The sentence that says “pneumothorax” is the same sentence that carries the drive. `speech_on_viewport` fails.
- **Window before scroll.** `set_window` then the seat. `human_sequence` fails.
- **Zoom after the laser.** `show_finding` and then `zoom_to`. `human_sequence` fails. `show_finding` alone on the nodule fails the same way: the laser is up and the magnification never happened.
- **`set_zoom`.** Same effect as `zoom_to`. The alias can be world-class when it sits in the consultant slot.

## Live model

`--live` calls `runTeachingPlan` (the same function as `POST /api/tutor`)
with the fixture’s findings context and each beat’s prompt. Mock mode does
not import the Gemini client.

The guided prompt prefers `play_guide` and still mentions `set_window` before
`show_finding`. This harness scores the viewport those calls leave behind.
A live model that only talks fails `text_only`. A live model that moves the
viewer and says nothing fails `spoken_beat`. A live model that zooms after
the laser fails `human_sequence`. A blank `play_guide` is the organized
script: drive first, then the pearl names the finding.
