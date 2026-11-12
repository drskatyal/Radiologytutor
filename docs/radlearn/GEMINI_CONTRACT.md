# Gemini M3 local contract evidence

**NOT VERIFIED LIVE — live contract not verified.** No live API call, credential
inspection, new dependency, deployment, push or PR was made for M3.

The adapter uses `gemini-3.8-flash` via generateContent for text/STT/extraction/
planning, `gemini-3.8-flash-tts` via unary Interactions for TTS, and the separate
existing `gemini-3.8-live` path for realtime. Configuration overrides never
silently switch model or API surface. See [the verification notes](GEMINI_VERIFICATION.md)
for the offline documentation citations and request-shape decision.

`lib/gemini.request.test.ts` compares complete URL/body snapshots in
`lib/fixtures/gemini/{extraction,plan,tts}.json`, with transport replaced by a
local response stub. It verifies capability errors, no model fallback on an API
refusal, metadata propagation/hashing, both media-resolution forms, PHI blocking
and ElevenLabs priority. `lib/tts.wav.test.ts` verifies synthetic WAV and L16
bytes, invalid containers and exact preservation. `lib/geminiPolicy.test.ts`
and `lib/geminiLiveProtocol.test.ts` cover the sampling-removal boundary.

These tests verify our request construction and decoding, **not** provider
acceptance, speech quality, latency or production readiness. In particular,
`mediaProcessing` and the object/string mediaResolution compatibility choice
remain unverified against a live generateContent contract. A future explicitly
authorized synthetic live check is still needed; no live-check script was run.

Full suite results and the read-only gate are recorded in
`/workspace/radlearn-build-status.md`; committed M3 logs are in `evidence/`.

## M6 retained extraction

The new retained-media prompt/schema and job runner have mocked local request,
response, Files-upload and retry tests. `lib/extract/prompt.test.ts` asserts the
safe clock, offsets, explicit model, JSON request, absent sampling/Search tools
and absence of PHI/answer canaries. Request metadata is persisted with each job
and resulting finding version. The browser fixture injects a mock into this same
runner; production routes have no fixture/model bypass. No optional live check
was run: **NOT VERIFIED LIVE — live contract not verified**. No live GCP call.
