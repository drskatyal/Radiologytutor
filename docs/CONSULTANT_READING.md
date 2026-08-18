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
   │ (teacher voiceId)   │               │ audio + ephemeral token) │
   └─────────────────────┘               └──────────────────────────┘
              │                                         │
              └────────────────────┬────────────────────┘
                                   ▼
                         Student hears + sees viewer move
```

| Concern | Choice | Env |
|---------|--------|-----|
| Orchestration / STT / tools | **Gemini Flash** (`GEMINI_MODEL`, default **`gemini-3.7-flash`**) | `GEMINI_API_KEY` |
| Live tutor voice (cloned) | **ElevenLabs** Instant/Professional Voice Clone | `ELEVENLABS_API_KEY` |
| Default TTS if no clone / no ElevenLabs | Gemini TTS | `GEMINI_TTS_*` |
| High-latency escape hatch | **Gemini Live** native audio (`GEMINI_LIVE_MODEL`) via ephemeral token from `POST /api/voice/realtime` | same Gemini key |
| Soft budget before preferring Live | `VOICE_LATENCY_BUDGET_MS` (default 1200) — TTS responses set `X-FlowRad-Voice-Budget-Exceeded` | |
| Browser last resort | `speechSynthesis` | — |

Model ids move fast (3.6 → 3.7 Flash within weeks). Pin via `GEMINI_MODEL`;
`gemini-3.7-flash` is the current workhorse default. Keep TTS / Live model ids
separate — they are different surfaces.

## Teacher voice enrollment

1. Teacher records ≥1–2 min of clean narration in Studio (or uploads samples).
2. `POST /api/studio/voice` → ElevenLabs instant clone → store `voiceId` on
   `Author` / `AuthorProfile.voice`.
3. Student case player passes `authorVoiceId` into `/api/tts`.
4. Consent + disclosure: “This tutor speaks in a synthetic voice modeled on
   Dr. X’s teaching samples.” Required before public clone use.

## Gemini Live fallback (how it works)

1. Client calls `/api/tts` for cloned / Gemini speech.
2. If `X-FlowRad-Voice-Budget-Exceeded: 1`, `lib/speak.ts` sets
   `shouldPreferRealtimeVoice()` for the next turn.
3. Client `POST /api/voice/realtime` → server mints a **v1alpha ephemeral
   token** constrained to our Live model + AUDIO modality.
4. Browser opens Google’s Live WebSocket with that token — **never** the
   long-lived `GEMINI_API_KEY`.

Full duplex mic→Live in the student UI is the next wiring step; the mint +
capability endpoints are live so the UI can detect and switch.

## What still makes it “as close as a radiologist”

Beyond voice:

1. **Dense capture** — WW/WC, series switches, zoom/pan, Length/HU measurements.
2. **Adaptive windowing** — scroll when Δ small, snap bone↔lung.
3. **Measurement overlay replay** — student reveal redraws authored calipers
   from `Finding.measurements` handles (`MeasurementOverlay`).
4. **Image-plane markers** — next (stable under pan/zoom).
5. **Interleaved speech + viewer** — beat-synced laser / `show_finding`.
6. **Don’t invent** — tutor only cites authored pearls / meas / voi.

## Seams (code)

| Module | Role |
|--------|------|
| `lib/voice.ts` | Provider selection; `synthesizeTutorSpeech` + latency budget |
| `lib/elevenlabs.ts` | Clone + TTS (no imports outside voice seam) |
| `lib/voiceRealtime.ts` | Live info + ephemeral token mint |
| `lib/gemini.ts` | Flash generate / STT / Gemini TTS |
| `lib/speak.ts` | Client playback; never knows the vendor |
| `/api/tts` | Server TTS; optional `voiceId` / `authorId` |
| `/api/voice/realtime` | Mint Live ephemeral token (POST) / capability (GET) |
| `/api/studio/voice` | Teacher enroll / status |

Mirror `lib/auth.ts` / `lib/payments.ts`: **no `elevenlabs` import outside
`lib/elevenlabs.ts` + `lib/voice.ts`.**
