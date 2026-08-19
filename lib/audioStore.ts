// ============================================================================
// lib/audioStore.ts  (server only)
//
// Storage seam for narration audio captured during record → replay.
//
// Prefer Cloudflare R2 when configured (`lib/r2.ts`). Fall back to
// DATA_DIR/audio/<id>.<ext> (JSON-on-volume / local) so dev and `npm run build`
// work with no bucket. GET /api/audio/[id] always serves bytes through this
// module — the client never sees storage credentials.
//
// `audioUrl` is always our own same-origin route (/api/audio/<id>), so the
// URL is durable across stores. Do not return R2 public URLs to the client.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import { getObject, putObject, r2Configured } from "./r2";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");

/** Public URL the client uses to fetch a stored clip. Store-independent. */
export function audioUrl(id: string): string {
  return `/api/audio/${id}`;
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function extFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

function genId(): string {
  return `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function r2Keys(id: string, ext: string): { bytes: string; meta: string } {
  return { bytes: `audio/${id}.${ext}`, meta: `audio/${id}.json` };
}

export interface StoredAudio {
  id: string;
  url: string;
  mimeType: string;
  bytes: number;
}

interface AudioMeta {
  mimeType: string;
  ext: string;
  bytes: number;
}

/** Persist a base64 clip; returns its id + same-origin URL. */
export async function putAudio(base64: string, mimeType: string): Promise<StoredAudio> {
  const id = genId();
  const ext = extFor(mimeType);
  const buf = Buffer.from(base64, "base64");
  const meta: AudioMeta = { mimeType, ext, bytes: buf.length };
  const stored: StoredAudio = { id, url: audioUrl(id), mimeType, bytes: buf.length };

  if (r2Configured()) {
    const keys = r2Keys(id, ext);
    const put = await putObject(keys.bytes, buf, mimeType);
    if (put) {
      await putObject(keys.meta, Buffer.from(JSON.stringify(meta), "utf-8"), "application/json");
      return stored;
    }
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  await fs.writeFile(path.join(AUDIO_DIR, `${id}.${ext}`), buf);
  await fs.writeFile(path.join(AUDIO_DIR, `${id}.json`), JSON.stringify(meta), "utf-8");
  return stored;
}

export interface AudioBytes {
  bytes: Buffer;
  mimeType: string;
}

/** Read a stored clip back (for GET /api/audio/[id]). Null when missing. */
export async function getAudio(id: string): Promise<AudioBytes | null> {
  const clean = safeId(id);
  if (!clean) return null;

  if (r2Configured()) {
    const fromR2 = await getAudioFromR2(clean);
    if (fromR2) return fromR2;
  }

  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(AUDIO_DIR, `${clean}.json`), "utf-8")
    ) as AudioMeta;
    const bytes = await fs.readFile(path.join(AUDIO_DIR, `${clean}.${meta.ext}`));
    return { bytes, mimeType: meta.mimeType };
  } catch {
    return null;
  }
}

async function getAudioFromR2(id: string): Promise<AudioBytes | null> {
  const metaObj = await getObject(`audio/${id}.json`);
  if (!metaObj) return null;
  let meta: AudioMeta;
  try {
    meta = JSON.parse(metaObj.bytes.toString("utf-8")) as AudioMeta;
  } catch {
    return null;
  }
  const clip = await getObject(`audio/${id}.${meta.ext}`);
  if (!clip) return null;
  return { bytes: clip.bytes, mimeType: meta.mimeType };
}
