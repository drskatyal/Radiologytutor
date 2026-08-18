# Consultant reading authenticity

FlowRad’s product thesis: we are not “an AI that knows radiology.” We are
**teaching the AI (and the student) how THIS consultant read THIS scan** —
windowing, scroll path, click, calipers, and the words they used — then
replaying and extending that craft in the consultant’s voice.

## Three layers of authenticity (do not collapse them)

| Layer | What the student gets | Source of truth |
|-------|----------------------|-----------------|
| **1. Exact retrace** | Teacher’s real mic + dense viewer events (slice/VOI/cursor) | `Finding.track` + `audioUrl` |
| **2. Authored landing** | Slice + SOP + WW/WC + marker + measurements | Finding fields (see `FINDING_LOCALIZATION.md`) |
| **3. Live Q&A** | Tutor answers new questions, drives the viewer, **speaks like the teacher** | Gemini Flash orchestration + voice seam |

Layer 1 is sacred: **never re-TTS recorded walk-throughs.** The consultant’s
actual take is the gold recording. Cloning is only for Layer 3 (and optional
short stems when no track exists).

## Voice stack (locked direction)

```
                    ┌─────────────────────────────┐
  Student mic  ──►  │  STT: Gemini Flash          │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │  Tutor plan: Gemini Flash   │
                    │  (tools: show_finding,      │
                    │   set_window, point_to, …)  │
                    └──────────────┬──────────────┘
                                   ▼
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
   ┌─────────────────────┐               ┌──────────────────────────┐
   │ Primary TTS         │               │ Latency fallback         │
   │ ElevenLabs          │               │ Gemini Live (native      │
   │ (teacher voiceId)   │               │ audio WebSocket)         │
   └─────────────────────┘               └──────────────────────────┘
              │                                         │
              └────────────────────┬────────────────────┘
                                   ▼
                         Student hears + sees viewer move
```

| Concern | Choice | Env |
|---------|--------|-----|
| Orchestration / STT / tools | **Gemini Flash** (`GEMINI_MODEL`, default `gemini-2.5-flash`) | `GEMINI_API_KEY` |
| Live tutor voice (cloned) | **ElevenLabs** Instant/Professional Voice Clone | `ELEVENLABS_API_KEY` |
| Default TTS if no clone / no ElevenLabs | Gemini TTS (current) | `GEMINI_TTS_*` |
| High-latency escape hatch | **Gemini Live** native audio (`gemini-live-2.5-flash-native-audio`) | same Gemini key |
| Browser last resort | `speechSynthesis` | — |

There is no stable “Gemini 3.6 Flash” id in Google’s public model list as of
this writing — pin via `GEMINI_MODEL` and bump when Google ships the next Flash.
Prefer `gemini-2.5-flash` or `gemini-flash-latest` for tool-calling + STT.

## Teacher voice enrollment

1. Teacher records ≥1–2 min of clean narration in Studio (or uploads samples).
2. `POST /api/studio/voice` → ElevenLabs instant clone → store `voiceId` on
   `Author` / `AuthorProfile.voice`.
3. Student case player passes `authorVoiceId` into `/api/tts`.
4. Consent + disclosure: “This tutor speaks in a synthetic voice modeled on
   Dr. X’s teaching samples.” Required before public clone use.

## What still makes it “as close as a radiologist”

Beyond voice:

1. **Dense capture** — WW/WC, series switches, zoom/pan, Length/HU measurements
   (already shipping).
2. **Adaptive windowing** — scroll when Δ small, snap bone↔lung.
3. **Image-plane markers** — next (stable under pan/zoom).
4. **Interleaved speech + viewer** — already: beat-synced laser / `show_finding`.
5. **Don’t invent** — tutor only cites authored pearls / meas / voi.
6. **Realtime path** — when Flash+ElevenLabs RTT is high, fall over to Gemini
   Live for conversational turns while still emitting the same viewer tools
   from a parallel text channel (or Live function calling).

## Seams (code)

| Module | Role |
|--------|------|
| `lib/voice.ts` | Provider selection; `synthesizeTutorSpeech` |
| `lib/elevenlabs.ts` | Clone + TTS (no imports outside voice seam) |
| `lib/gemini.ts` | Flash generate / STT / Gemini TTS / Live stub hooks |
| `lib/speak.ts` | Client playback; never knows the vendor |
| `/api/tts` | Server TTS; optional `voiceId` / `authorId` |
| `/api/studio/voice` | Teacher enroll / status |

Mirror `lib/auth.ts` / `lib/payments.ts`: **no `elevenlabs` import outside
`lib/elevenlabs.ts` + `lib/voice.ts`.**
