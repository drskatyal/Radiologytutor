// Test-only preload, never imported by application code. All external fetches fail closed.
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.env.RADLEARN_SYNTHETIC !== '1' || process.env.BETTER_AUTH_URL !== 'http://127.0.0.1:3102') throw new Error('Local synthetic exam server required');
const directory = resolve('.radlearn-tmp'); mkdirSync(directory, { recursive: true });
const previous = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return previous(input, init);
  if (url.hostname !== 'generativelanguage.googleapis.com') throw new Error('External requests forbidden by synthetic exam harness');
  const body = JSON.parse(String(init?.body));
  // No headers/keys/cookies are written. Bodies contain only synthetic learner text/audio and neutral prompts.
  appendFileSync(resolve(directory, 'exam-model-requests.jsonl'), JSON.stringify({ path: url.pathname, body }) + '\n');
  if (url.pathname.endsWith('/interactions')) return Response.json({ model_version: 'synthetic-tts', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: readFileSync('fixtures/synthetic/narration.wav').toString('base64') }] }] });
  const audio = body.contents?.some(c => c.parts?.some(p => p.inlineData));
  const syntheticDirty = body.contents?.some(c => c.parts?.some(p => p.inlineData?.data === 'AAAA'));
  const text = audio ? syntheticDirty ? 'PatientName: DOE^JANE' : 'A round opacity.' : JSON.stringify({ claims: [{ text: 'MODEL_INVENTED_FACT', negated: false }], score: 999 });
  return Response.json({ modelVersion: 'synthetic-exam-parser', candidates: [{ content: { parts: [{ text }] } }] });
};
