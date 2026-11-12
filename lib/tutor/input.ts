import { assertNoPhi } from '../phiGuard';
export function tutorAudio(input: unknown): { base64: string; mime: string } {
  const audio = input as { base64?: unknown; mime?: unknown; phiReviewed?: unknown };
  if (!audio || audio.phiReviewed !== true) throw new Error('Confirm the question contains no patient identifiers.');
  if (typeof audio.base64 !== 'string' || !audio.base64 || audio.base64.length > 8_000_000 || !/^[A-Za-z0-9+/=]+$/.test(audio.base64)) throw new Error('Invalid or oversized microphone recording.');
  if (typeof audio.mime !== 'string' || !['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg'].includes(audio.mime)) throw new Error('Unsupported microphone audio format.');
  return { base64: audio.base64, mime: audio.mime };
}
export function tutorText(text: unknown): string {
  if (typeof text !== 'string' || text.length > 16000) throw new Error('Invalid tutor text.'); assertNoPhi(text); return text;
}
