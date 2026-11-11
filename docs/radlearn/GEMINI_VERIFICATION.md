# Gemini and TTS verification supplied by the orchestrator

The orchestrator checked official Google documentation on 11 November 2026,
approximately 20:30 London. This table records that supplied evidence; it is not
a new network check or a live API contract test. **NOT VERIFIED LIVE — live
contract not verified.** All local model tests use mocks.

| Claim | Verification supplied | Official documentation |
|---|---|---|
| 2.5 Flash/Pro preview TTS shutdown 17 November 2026; replacements 3.8 Flash TTS / Flash Lite TTS | CONFIRMED | [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) |
| gemini-3.8-flash accepts text/image/video/audio/PDF, returns text only; no audio generation or Live API | CONFIRMED | [3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| gemini-3.8-live released 15 September 2026; 3.8 TTS models released 22 September; no listed shutdown | CONFIRMED | [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) |
| temperature/top_p/top_k deprecated and ignored from 3.6 Flash, with future HTTP 400 behavior | CONFIRMED | [Gemini 3 changes](https://ai.google.dev/gemini-api/docs/gemini-3) |
| gemini-3.8-flash-tts exists; unary output WAV/RIFF, 24 kHz mono 16-bit LE; streaming raw audio/l16; style via speech_metadata | CONFIRMED | [Speech generation](https://ai.google.dev/gemini-api/docs/speech-generation) |
| Video defaults to static 1 fps; 3.8 Flash supports opt-in agentic video | CONFIRMED; exact repo field `mediaProcessing` is NOT verified | [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) |

The 1 fps sampler cannot provide exact replay timing or geometry. The render
journal remains authoritative. Flash, Live and TTS are separate capabilities.
The exact request schema, including mediaProcessing and speech_metadata nesting,
requires a schema snapshot and later contract verification; no field shape is
inferred from the supplied claim alone. ElevenLabs remains the primary speech
provider. No deployment or TTS hotfix is authorised.
