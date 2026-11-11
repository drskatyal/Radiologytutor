import { test } from "node:test";
import assert from "node:assert/strict";
import { ttsAudioToWav, TtsAudioError } from "./tts.wav";

// Independent synthetic WAV fixture: mono PCM16 at 24 kHz, two samples.
const wav = () => Buffer.from("524946462800000057415645666d74201000000001000100c05d000080bb00000200100064617461040000000000ff7f", "hex");

test("unary RIFF/WAV is byte-for-byte preserved, even with an L16 MIME label", () => {
  for (const mime of [undefined, "audio/wav", "audio/L16;rate=24000"]) {
    const original = wav();
    assert.equal(ttsAudioToWav(original, mime), original);
    assert.equal(original.length, 48);
  }
});

test("raw audio/l16 receives exactly one mono PCM16 WAV header and preserves samples", () => {
  const pcm = Buffer.from([0, 0, 255, 127]);
  assert.deepEqual(ttsAudioToWav(pcm, "audio/l16"), wav());
  const result = ttsAudioToWav(pcm, "audio/L16;codec=pcm;rate=16000;channels=1");
  assert.equal(result.readUInt32LE(24), 16000);
  assert.equal(result.readUInt32LE(28), 32000);
  assert.deepEqual(result.subarray(44), pcm);
  assert.equal(result.readUInt32LE(4), result.length - 8);
});

test("valid ancillary WAV chunks are retained", () => {
  const source = wav();
  const withChunk = Buffer.concat([source.subarray(0, 36), Buffer.from("4a554e4b020000000000", "hex"), source.subarray(36)]);
  withChunk.writeUInt32LE(withChunk.length - 8, 4);
  assert.equal(ttsAudioToWav(withChunk), withChunk);
});

test("malformed RIFF is rejected instead of wrapped as raw PCM", () => {
  const corrupt = wav(); corrupt.write("XXXX", 8);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  const missingData = wav(); missingData.write("JUNK", 36);
  for (const bytes of [Buffer.from("RIFF"), wav().subarray(0, 46), corrupt, stereo, missingData]) {
    assert.throws(() => ttsAudioToWav(bytes, "audio/l16"), TtsAudioError);
  }
});

test("unsupported encoding, truncated samples and invalid rate/channels fail closed", () => {
  for (const mime of ["audio/mp3", "audio/wav", "audio/l16;rate=0", "audio/l16;rate=nan", "audio/l16;rate=24000.5", "audio/l16;channels=2"]) {
    assert.throws(() => ttsAudioToWav(Buffer.alloc(4), mime), TtsAudioError);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(3)]) assert.throws(() => ttsAudioToWav(bytes, "audio/l16"), TtsAudioError);
});
