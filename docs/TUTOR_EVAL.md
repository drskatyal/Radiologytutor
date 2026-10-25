# Tutor eval — did it drive the viewer?

A radiology teacher moves the scan and talks about what is now on the screen.
A chatbot writes a correct paragraph while the image sits still. This eval
exists to fail the second one.

```
npm run eval:tutor
```

Exit 0 only when a text-only fake **fails** and a viewer-driving reference
**passes**. That is the CI contract. It does not call Gemini and needs no API key.

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

| Finding | Slice | Window | Marker | Teacher track |
|---|---|---|---|---|
| Right apical pneumothorax | 8 | 1500 / -600 | (0.28, 0.22) | scroll to the apex, lung window, point |
| Left lower lobe nodule | 27 | 1500 / -600 | (0.70, 0.62) | scroll down, **zoom 2.2×**, point |

`teachingGuide` on each beat is the student-facing script (window first,
because the learner is on the wrong window). The finding `track` is how the
consultant already read it (they started on lung windows). Those are not the
same clock, on purpose.

If a beat omits `teachingGuide`, `teachingGuideFromTrack` builds one from the
track, including `zoom_to`. That is the hook for a future capture pipeline.

## What “drive the viewer” means

The scorer applies the same tools the student client applies
(`lib/harness/tools.ts`, `useStudentSession.executeAction`):

| Tool | Effect |
|---|---|
| `show_finding` | Scroll to the authored slice, apply authored WW/WC, then the laser. One action. Slice and window share a rank; the laser is after them. |
| `next_in_tour` / `prev_in_tour` | Same reveal, on the next or previous finding in `order`. From no active finding, next seats the first. |
| `set_window` | WW/WC only. Values must match the authored VOI (±20). |
| `point_to` with a finding you are not on | Full reveal (the client does this), not a laser on the wrong slice. |
| `point_to` with raw `x_pct` / `y_pct` | Laser immediately, no window change. |
| `scroll_to` | Scroll to that slice. Also satisfied by `show_finding` or the tour. |
| `zoom_to` | Set magnification. Hard step on any guide beat that zooms (the nodule is 2.2×). |

`scroll_to` in a guide is a hard step, satisfied by `show_finding` or the tour.
`zoom_to` is registered, so a nodule beat that never zooms fails `order`.
`show_finding` alone is not enough for that beat.

Wall-clock latency is not scored. `t` on the guide is order only. Speech and
the first tool are paired with `buildPerformancePlan`: the first sentence
must carry a viewer action.

## Hard checks (any miss → verdict FAIL, score 0)

Headline score is 0 or 100. A decent sentence does not earn partial credit.
The per-check lines still say which sentences happened to be fine.

| Check | Fail |
|---|---|
| `text_only` | No live tool. This is the chatbot. |
| `look_with_drive` | The first spoken sentence does not carry a tool. |
| `seated_finding` | Never seated this finding, or seated a different one. |
| `order` | A later guide step landed strictly before an earlier one, or a gating step never happened. Slice and window in the same `show_finding` may tie. |
| `pointer_before_window` | The laser moved while the window was still the wrong preset. |
| `landing_slice` | Final slice is not the finding’s slice. |
| `landing_window` | Final WW/WC is not the authored VOI (±20). |
| `landing_pointer` | Pointer misses the marker. Hit radius is `DEFAULT_HIT_RADIUS` (0.08), the same radius as click-the-finding. |
| `hallucinated_window` | Any window effect in the turn is not the authored VOI, even if a later tool corrects it. |
| `narration_present` | Nothing was said. |
| `look_cue` | The first sentence does not start with look / see / watch / follow. |
| `narration_on_screen` | Speech never uses this beat’s distinctive terms. |
| `narration_ahead` | Speech names a **later** finding’s distinctive terms. Earlier findings may be mentioned. |
| `narration_hygiene` | Speech contains a finding id, a `0.xx` coordinate, or a field name (`sliceIndex`, `windowWidth`, …). |

A reference narration that describes the pneumothorax accurately and says
“look at this slice”, with **no tools**, fails. That is the product.

## What a pass is not

`VERDICT PASS` means the turn drove this fixture: right slice, right window,
pointer on the marker, tools in an order a teacher would accept, speech about
the finding on the screen.

`world YES` means that, and every guide step fired, including zoom.

The reference driver emits `zoom_to` 2.2× on the nodule, then points again
so the laser lands on the magnified image. That scorecard is `world YES`.
A turn that only calls `show_finding` still fails the nodule. Do not read a
pneumothorax-only pass as “the tutor can teach the whole case.”

## Live model

`--live` calls `runTeachingPlan` (the same function as `POST /api/tutor`)
with the fixture’s findings context and each beat’s prompt. Mock mode does
not import the Gemini client.

The guided system prompt tells the model the client already seats the opening
slice and not to `next_in_tour` during an auto-tour. This harness does **not**
pre-seat. A live model that obeys that sentence and only talks fails
`text_only` on purpose. The prompts in the fixture ask it to drive anyway
(“I am on soft-tissue windows… drive the viewer”).
