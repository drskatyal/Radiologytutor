# Gauntlet — AI radiology teacher (Phase 0 → N)

> Status: **Phase 3 (interleave + report grade)** on `cursor/interleave-voice-a5b0`.
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
| Side-by-side viewers | Dual Cornerstone stacks with unique engine ids. A finding with a `viewportRole: secondary` anchor opens compare automatically. Manual `C` toggles a second pane. |
| Click-the-finding | Viva locate mode: student click vs authored `[0,1]` marker (`lib/clickFinding.ts`). Hit reveals; miss hints. |
| Student chrome / viva | Collapsed rail + **on-image examiner caption**. Full-bleed reading room (no app sidebar). Progress dots, auto-begin stem, hide-until-reveal, Don't know / Reveal, `?` hotkeys. Guided still auto-advances; viva waits for an answer. |
| Speak + drive simultaneously | Performance plan: sentence-chunked TTS (`speakBeats`) + viewer tools on the first beat. Laser and first sentence start together. Guided auto-advances after the last beat. Viva waits. |
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
3. **P2:** dual viewport compare + click-the-finding locate; author pins a secondary landing.
4. **P3 (this loop):** sentence-pipelined TTS + interleaved tool calls; progressive caption. Space barges in (duplex-lite).
5. **P4 (this loop, slice):** AI-graded structured report against the authored rubric (never a bare score). MCQ still later.

---

## Non-goals (yet)

- Replacing Orthanc
- Building a second viewer stack
- Monetization / CME credit language
