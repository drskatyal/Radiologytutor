# FlowRad Learn — the radiology registrar harness

## What we are building (and what we are not)

We are **not** replacing radiologists. We are building a **harness**: an
environment + tools + schemas that lets AI models (STT, reasoning, TTS) become
excellent **teachers of radiology reporting** when armed with how a real
consultant read a study.

Think of [Grok Bot](https://docs.x.ai/grok-bot/overview) for a doctor’s
workflow — a teammate with its **own computer**, tools, and the ability to
**learn a routine from live demonstration**. Our registrar harness is the
same pattern, scoped to teaching:

| Grok Bot | FlowRad harness |
|----------|-----------------|
| Persistent cloud computer | Self-hosted **DICOM viewer** (Cornerstone + Orthanc) |
| Apps / connectors / MCP | Viewer **tools** (`show_finding`, `set_window`, `point_to`, …) + STT/TTS |
| Learn workflow from demonstration | Teacher **walk-through + dictation** on one clock |
| Routine / skill | Durable `CaptureSession` → structured **Findings** JSON |
| Persistent teammate memory | Case findings + reading digests + author voice |
| Finish real work (not chat drafts) | Drive pixels + speak report language end-to-end |

The AI does not invent a search pattern from the open web of radiology. It
runs **inside** this harness, constrained by authored schema and tool calls.

## Harness loop (two phases)

```
┌──────────────────────── AUTHORING (demonstration) ─────────────────────────┐
│  Teacher scrolls / windows / measures / clicks while dictating              │
│       │                                                                      │
│       ├─ viewer events  ──► RecordedTrack (t, slice, voi, camera, cursor…)   │
│       └─ mic audio      ──► STT + structure JSON (label, pearls, tStart/End) │
│                              │                                               │
│                              ▼                                               │
│                    mergeCapture (lib/harness)                                 │
│                              │                                               │
│                              ▼                                               │
│              CaptureSession + Finding[]  (schema + timestamps)               │
└──────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────── LEARNING (teammate) ───────────────────────────────┐
│  Registrar opens case                                                        │
│       │                                                                      │
│       ├─ context: findings + readingDigest (how the consultant read)         │
│       ├─ tools:   TEACHING_TOOLS (viewer drive)                              │
│       ├─ voice:   STT → tutor plan → TTS / Live / cloned voice               │
│       └─ modes:   Teach (autonomous) · Exam · Report coach                   │
│                                                                              │
│  Result: AI attending drives the scan while teaching how to REPORT it        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Schemas (the contract)

**StructuredFinding** (per dictate):

```json
{ "label": "string", "description": "string", "teachingPoints": ["…"] }
```

**StructuredSession** (continuous take):

```json
{
  "transcript": "string",
  "findings": [
    {
      "label": "string",
      "description": "string",
      "teachingPoints": ["…"],
      "tStartMs": 0,
      "tEndMs": 12000
    }
  ]
}
```

**RecordedTrack** (DICOM walk-through on the same clock):

```ts
{ durationMs, start: { sliceIndex, ww?, wc? }, events: RecordedEvent[], audioUrl? }
```

**Merge** (`lib/harness/mergeCapture.ts`): for each speech segment, slice the
track, land marker/slice/series/VOI from events near `t`, emit a Finding draft
plus a durable `CaptureSession` on the case.

## Tool surface (the computer’s API)

Defined once in `lib/harness/tools.ts`, consumed by Gemini tutor calls:

| Tool | Effect on the computer (viewer) |
|------|----------------------------------|
| `show_finding` | Seat series/slice/VOI + laser to authored marker |
| `next_in_tour` / `prev_in_tour` | Advance tour order |
| `set_window` | Adaptive WW/WC |
| `point_to` | Laser to finding marker or `[0,1]` |

Speech and tools are interleaved (`lib/performancePlan.ts`) so the registrar
hears and sees the report unfold together.

## Voice stack (pluggable models)

STT / orchestration / TTS are **adapters** behind seams — swap Gemini Flash,
ElevenLabs clone, Gemini Live — the harness contract stays:

| Concern | Seam |
|---------|------|
| STT | `/api/transcribe` → `lib/gemini.ts` |
| Structure | `/api/structure-finding`, `/api/structure-session` |
| Tutor plan | `/api/tutor` + `TEACHING_TOOLS` |
| Speech out | `lib/voice.ts` (ElevenLabs → Gemini TTS → Live token) |

## Code map

| Module | Role |
|--------|------|
| `docs/HARNESS.md` | This document |
| `lib/harness/` | Merge + tool registry (the harness core) |
| `lib/captureSession.ts` | Time ↔ track queries (`sliceNearTime`, …) |
| `lib/readingDigest.ts` | Track → compact tutor context |
| `lib/recorder.ts` / `useRecordReplay` | Shared authoring clock |
| `components/author/ContinuousCapture.tsx` | Speak-once demonstration UI |
| `components/student/*` | Registrar teammate UI (Teach / Exam / Report) |

## Done vs next

**Done:** viewer computer, tool calling (`lib/harness/tools`), structure schemas,
timestamped tracks, `mergeCaptureDemonstration` → Findings + durable
`CaptureSession` (`POST /api/cases/[id]/capture-sessions`), ContinuousCapture
wired through the merge, Teach loop, report coach, voice adapters.

**Next (deepen the harness):** richer observation tools (expose digest/meas as
tool results), time-cropped audio per finding, Live duplex as default when TTS
budget trips, optional “follow me once” skill export for multi-case routines.
