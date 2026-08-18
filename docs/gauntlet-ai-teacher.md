# Gauntlet — AI radiology teacher (Phase 0 → N)

> Status: **Phase 1.5 (reading-room craft)** on `cursor/reading-room-craft-a5b0`.
> Product truth: the AI never invents anatomy. It teaches from what a
> radiologist authored — clicks, series, slices, and dictated evidence —
> then *performs* that script like an examiner: drives the viewer while speaking.

---

## North star

A radiologist scrolls a study once, speaking naturally. The platform timestamps
every viewer change and the voice on one clock, then structures the session into
ordered findings (JSON schema) with anchors (study / series / SOP / slice /
normalized marker). A student opens the case into a reading-room viva: almost no
chrome, one mic, an examiner AI that speaks, searches the web for that case, and
autonomously advances through findings while tuning the viewer.

---

## Hard problems (and the tackles)

| Problem | Approach |
|--------|----------|
| One continuous dictation → many findings | `CaptureSession`: one `RecordedTrack` + audio; `/api/structure-session` segments by speech + event density into `StructuredSessionFinding[]` with `tStartMs`/`tEndMs`. Author reviews fields before save. |
| Exact place on the image | `FindingAnchor`: `marker` `[0,1]` + `sliceIndex` + `seriesInstanceUID` + optional `sopInstanceUID` + `studyInstanceUID`. Primary `Finding.marker` / series fields remain for back-compat. |
| Same finding, multiple series | `Finding.anchors[]` — one logical finding, N viewport landings (e.g. axial + coronal). Tutor `show_finding` cycles primary then secondary on ask. |
| Same finding, CT + MRI (multi-study) | Anchors carry `studyInstanceUID` + `studyRole` (`current`/`prior`). Side-by-side layout is Phase 2 (`viewportRole: primary\|secondary`). |
| Side-by-side viewers | Phase 2: dual Cornerstone viewports bound to two anchors of the active finding. Phase 1 stores the data so we don't refactor later. |
| Student chrome / viva | Collapsed rail + **on-image examiner caption**. Full-bleed reading room (no app sidebar). Progress dots, auto-begin stem, hide-until-reveal, Don't know / Reveal, `?` hotkeys. Guided still auto-advances; viva waits for an answer. |
| Speak + drive simultaneously | Reveal finding (laser/track) **then** speak; guided/viva auto-`next_in_tour` after speech ends unless student barges in. |
| Hallucinations | Structure prompts: *only* radiologist words; tutor tools only jump to authored finding IDs / markers; never invent coordinates. |

---

## Data model (additive)

```
Case
  captureSessions?: CaptureSession[]   // continuous author takes
  findings: Finding[]                  // teaching units (structured)

CaptureSession { id, durationMs, track, audioUrl?, transcript? }

Finding {
  …existing…
  sliceIndex?, sopInstanceUID?
  anchors?: FindingAnchor[]            // multi series/study landings
  captureSessionId?, tStartMs?, tEndMs?
}

FindingAnchor {
  studyInstanceUID?, seriesInstanceUID?, sopInstanceUID?
  sliceIndex?, marker, viewportRole?, studyRole?
}
```

---

## Phase map

1. **P1:** anchors + structure-session API + continuous author capture UI + student viva shell (collapsed, mic).
2. **P1.5 (this loop):** reading-room chrome, on-image examiner, hide-until-reveal, organized teaching sequence + publish readiness, tighter viva/structure prompts.
3. **P2:** dual viewport compare; anchor picker across studies; session → findings apply in one click.
4. **P3:** streaming TTS + tool calls interleaved; true duplex voice agent.
5. **P4:** assessment click-the-finding graded on anchors.

---

## Non-goals (yet)

- Replacing Orthanc
- Building a second viewer stack
- Monetization / CME credit language
