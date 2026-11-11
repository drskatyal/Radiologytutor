/** Unary 3.8 TTS returns WAV; audio/l16 is headerless little-endian PCM. */
export class TtsAudioError extends Error {
  readonly code = "GEMINI_INVALID_AUDIO";
  constructor(message: string) { super(message); this.name = "TtsAudioError"; }
}

function validRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= 8000 && rate <= 192000;
}

/** Preserve a complete PCM WAV, including optional chunks; reject truncation. */
function validateWav(audio: Buffer): void {
  if (audio.length < 44 || audio.toString("ascii", 8, 12) !== "WAVE" || audio.readUInt32LE(4) + 8 !== audio.length) {
    throw new TtsAudioError("Gemini TTS returned an invalid WAV container.");
  }
  let fmt = false;
  let data = false;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const length = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > audio.length) throw new TtsAudioError("Gemini TTS returned a truncated WAV chunk.");
    if (id === "fmt ") {
      if (length < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 ||
          audio.readUInt16LE(start + 14) !== 16 || audio.readUInt16LE(start + 12) !== 2 ||
          !validRate(audio.readUInt32LE(start + 4)) || audio.readUInt32LE(start + 8) !== audio.readUInt32LE(start + 4) * 2) {
        throw new TtsAudioError("Gemini TTS WAV must contain mono 16-bit PCM.");
      }
      fmt = true;
    }
    if (id === "data") {
      if (!length || length % 2) throw new TtsAudioError("Gemini TTS returned incomplete PCM samples.");
      data = true;
    }
    offset = start + length + (length % 2);
  }
  if (!fmt || !data || offset !== audio.length) throw new TtsAudioError("Gemini TTS WAV is missing complete audio chunks.");
}

export function ttsAudioToWav(audio: Buffer, mimeType = "audio/wav"): Buffer {
  // Inspect bytes before MIME: unary WAV must never receive a second RIFF header.
  if (audio.toString("ascii", 0, 4) === "RIFF") { validateWav(audio); return audio; }
  if (!/^audio\/l16(?:\s*;|$)/i.test(mimeType)) throw new TtsAudioError("Gemini TTS returned an unsupported audio encoding.");
  const rateParameter = /(?:^|;)\s*rate\s*=\s*([^;]+)/i.exec(mimeType);
  const channelParameter = /(?:^|;)\s*channels\s*=\s*([^;]+)/i.exec(mimeType);
  const sampleRate = rateParameter ? Number(rateParameter[1]) : 24000;
  if (!validRate(sampleRate) || (channelParameter && Number(channelParameter[1]) !== 1) || !audio.length || audio.length % 2) {
    throw new TtsAudioError("Gemini TTS requires complete mono 16-bit PCM samples and a valid rate.");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + audio.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}
