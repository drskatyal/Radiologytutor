# Consultant reading authenticity

FlowRad’s product thesis: we are **not** a tape recorder of a radiologist.
We are **arming an AI tutor with how THIS consultant read THIS scan** —
windowing, scroll path, zoom, clicks, calipers, and the words they used —
so a student can **talk with that tutor** like a teacher: discuss findings,
ask why, web-search guidelines, practice viva, and learn the craft.

The recorded walk-through is **training / grounding data for the model**,
not a student-facing slideshow of the teacher’s mic.

## What the student experiences

| Surface | What happens |
|---------|----------------|
| Viewer | AI drives slice / WW/WC / laser / caliper overlays via tools |
| Voice | Tutor speaks (ElevenLabs clone of the teacher when enrolled, else Gemini TTS / Live) |
| Chat | Discussion, questions, web-grounded answers |
| Modes | Guided tour, socratic, free explore, reporting, viva |

They do **not** watch a locked replay of the teacher’s Alt+X take. Author
Studio may still replay a track for QA while editing.

## How the recording arms the AI

```
  Teacher records (Studio)
       │
       ├─ structured text: label, description, teachingPoints
       ├─ landing: SOP / slice / WW/WC / marker / measurements
       └─ track: dense scroll / voi / zoom / cursor / series log (+ optional mic)
                │
                ▼
         readingDigest → compact "how they read" line in tutor context
                │
                ▼
  Student ↔ Gemini Flash (tools + web) ↔ voice (clone / Live)
                │
                ▼
         Viewer moves the way a teacher would teach — not a VCR
```

| Data | Role for the AI |
|------|-----------------|
| `label` / `description` / `teachingPoints` | What to say and ask |
| `windowWidth` / `windowCenter` / slice / SOP | Where to seat the eyes |
| `measurements[]` | Exact mm / HU the tutor may cite |
| `track` → `readingDigest` | Scroll habit, window changes, zoom range, pointing |
| `Author.voice` | Sound like this teacher on live turns |

## Voice stack (live discussion)

```
  Student mic ──► STT (Gemini Flash) ──► Tutor plan + tools (Gemini Flash)
                                              │
                         ┌────────────────────┴────────────────────┐
                         ▼                                         ▼
                  ElevenLabs clone                          Gemini Live
                  (teacher voiceId)                         (latency fallback)
```

| Concern | Choice | Env |
|---------|--------|-----|
| Orchestration / STT / tools | **Gemini Flash** (`GEMINI_MODEL`, default **`gemini-3.7-flash`**) | `GEMINI_API_KEY` |
| Tutor voice | **ElevenLabs** clone when enrolled | `ELEVENLABS_API_KEY` |
| TTS fallback | Gemini TTS | `GEMINI_TTS_*` |
| High-latency discussion | **Gemini Live** ephemeral token (`POST /api/voice/realtime`) | same Gemini key |
| Soft budget | `VOICE_LATENCY_BUDGET_MS` (default 1200) | |

Cloned / synthesized voice is correct here: the student is talking to an AI
teacher modeled on the consultant, not listening to a frozen recording.

## Author verification (Studio only)

`lib/replay.ts` still exact-replays a track so the teacher can check that
capture was faithful. That path is **author QA**, not the learner product.

## Seams

| Module | Role |
|--------|------|
| `lib/readingDigest.ts` | Track → compact tutor context |
| `lib/teachingPrompt.ts` | Findings + digests → system prompt |
| `lib/voice.ts` / `elevenlabs.ts` | Live tutor speech |
| `lib/voiceRealtime.ts` | Live WebSocket token mint |
| `lib/replay.ts` | Author-side verify only |

## Still to deepen

1. Optional ASR of the teacher’s mic into teaching pearls (when structured text is thin)
2. Richer digests (search pattern: lung bases → apices, bone→soft tissue, …)
3. Student Live duplex mic when TTS budget exceeded
4. Authored zoom/pan on static landings (today zoom lives mainly in track digests)
