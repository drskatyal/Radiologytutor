// Offline voice commands live in the shared viewer core
// (packages/viewer-core/src/voiceSession.ts); this path is kept for imports.

export {
  startVoice,
  prewarmVoice,
  voiceModelAvailable,
  voiceErrorText,
  VoiceError,
  type VoiceState,
  type VoiceProgress,
  type VoiceErrorKind,
  type VoiceOptions,
  type VoiceSession,
} from "@flowrad/viewer-core";

/** Same-origin URLs of the bundled model and the recognizer worker (scripts/fetch-voice-model.py, scripts/build-voice-worker.mjs). */
export const VOICE_MODEL_URL = "/voice/model.tar.gz";
export const VOICE_WORKER_URL = "/voice/recognizer-worker.js";
