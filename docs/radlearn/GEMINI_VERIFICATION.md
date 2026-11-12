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
The prior `speech_metadata` nesting hold is resolved by the official HTML pages
saved offline by the orchestrator for this M3 step. No web fetch or live provider
call was made. The `mediaProcessing` wire field remains unverified; its existing
behavior is retained rather than inferred from Interactions examples.

## M3 adapter choice (11 November 2026)

Use **unary Interactions only for Gemini TTS**, keeping extraction, STT and
planning on the existing `generateContent` adapter. This limits the API-surface
change to the feature whose documented style schema changed. The supplied
[speech-generation single-speaker REST example](https://ai.google.dev/gemini-api/docs/speech-generation#single-speaker)
uses `POST /v1beta/interactions` with this structure:

```json
{
  "model": "gemini-3.8-flash-tts",
  "input": [{"type": "user_input", "content": [{
    "type": "text", "text": "Review the synthetic image.",
    "annotations": [{"type": "speech_metadata", "style": "Calm, measured delivery."}]
  }]}],
  "response_format": {"type": "audio"},
  "generation_config": {"speech_config": [{"voice": "Kore"}]}
}
```

The adapter reads the last audio content block in `steps` with type
`model_output`, as that REST example does. It does not assume that the SDK's
`output_audio` accessor is a JSON response field. Sustained direction lives in
`speech_metadata.style`; spoken text contains only the requested utterance.

The saved speech-generation page, “Streaming audio generation” and “Audio output
formats” sections, specifies unary WAV/RIFF at 24 kHz, mono, 16-bit little-endian
PCM, and streaming headerless `audio/l16`. M3 preserves valid RIFF bytes and wraps
explicit raw L16 once. Invalid/truncated containers, unsupported formats, odd
PCM byte counts, invalid rates and stereo fail explicitly. We do not introduce
streaming transport; its raw format is covered with a synthetic response.

The migration section also permits `AUDIO_L16` in `generateContent`. We chose
Interactions because the offline material provides the complete REST nesting
for style there. There is no automatic API-surface or model retry. Transient
transport retries retain the same model and body; non-retryable API refusals
raise `GeminiApiError`. Wrong/unsupported model roles raise
`GeminiCapabilityError` before transport. Flash/Pro text-family overrides are supported;
TTS supports the documented 3.8 Flash/Flash Lite TTS IDs and Live supports
`gemini-3.8-live`. Other TTS/Live versions require explicit adapter validation.

The saved [Gemini 3 migration guide](https://ai.google.dev/gemini-api/docs/gemini-3)
“API changes and parameter updates” section removes temperature/top_p/top_k from
3.6+ and 3.5 Flash Lite. The shared policy strips both snake_case and camelCase
sampling spellings in Live setup; `generateContent` omits sampling for those
models, even when legacy internal callers still provide a temperature option.

Per-part media resolution is `{ "level": "MEDIA_RESOLUTION_LOW" }` by default,
with explicit `GEMINI_MEDIA_RESOLUTION_FORM=string` compatibility mode. Image and
video parts receive the default; audio/text do not. This implements strategy D1;
the supplied video page confirms resolution control but does not independently
settle this legacy REST field shape. Both forms are snapshot/assertion tested;
neither is claimed live verified. Unknown form values fail instead of guessing.

Every successful adapter response records `requestedModel`,
`responseModelVersion`, `apiSurface`, and `configHash` in a structured server log
and returns them as `modelMetadata`. Extraction, narration and teaching-plan
results propagate the server-observed metadata; generated JSON cannot supply it.
A missing response model version is **null**, never replaced with the requested
alias. `configHash` is SHA-256 of canonical `{model, apiSurface, body}` (including
prompt/config/media identity, excluding credentials and transport timeout).
The audit log contains only the four metadata fields, no clinical text or media.
Durable compile-job/run records remain M6 work. The neutral exam response makes
no model call and carries no model metadata.

ElevenLabs remains primary for enrolled discussion voices; the existing explicit
attending-guide Gemini route is preserved. The existing provider fallback policy
is separate from model substitution: Gemini never changes its configured model
or API surface in response to a failure. No deployment or remote hotfix occurred.

See [GEMINI_CONTRACT.md](GEMINI_CONTRACT.md) for validation limits and
[ACCEPTANCE_MAPPING.md](ACCEPTANCE_MAPPING.md) for M3's P0-7 tests. **NOT VERIFIED
LIVE — live contract not verified.**
