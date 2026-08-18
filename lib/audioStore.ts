// ============================================================================
// lib/audioStore.ts  (server only)
//
// Storage seam for narration audio captured during record → replay. Today we
// persist base64 audio as a file under DATA_DIR/audio/<id>.<ext> (survives
// redeploys on a Railway Volume, like the JSON case store) and serve it back
// through GET /api/audio/[id]. Tomorrow this swaps to R2/S3 without touching
// callers: reimplement `putAudio`/`getAudio` against the bucket and keep the
// returned `audioUrl` stable.
//
// `audioUrl` is always our own same-origin route (/api/audio/<id>), so the
// client never needs storage credentials and the URL is durable across stores.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";

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

export interface StoredAudio {
  id: string;
  url: string;
  mimeType: string;
  bytes: number;
}

/** Persist a base64 clip; returns its id + same-origin URL. */
export async function putAudio(base64: string, mimeType: string): Promise<StoredAudio> {
  const id = genId();
  const ext = extFor(mimeType);
  const buf = Buffer.from(base64, "base64");

  // Prefer R2 when configured (Fly production); fall back to local disk.
  try {
    const { r2Configured, r2PutObject } = await import("./r2");
    if (r2Configured()) {
      await r2PutObject(`audio/${id}.${ext}`, buf, mimeType);
      // Sidecar stays local/JSON-compatible for Content-Type on proxy miss;
      // public play URL remains same-origin /api/audio/<id>.
      await fs.mkdir(AUDIO_DIR, { recursive: true });
      await fs.writeFile(
        path.join(AUDIO_DIR, `${id}.json`),
        JSON.stringify({ mimeType, ext, bytes: buf.length, storage: "r2" }),
        "utf-8"
      );
      return { id, url: audioUrl(id), mimeType, bytes: buf.length };
    }
  } catch {
    /* fall through to disk */
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  await fs.writeFile(path.join(AUDIO_DIR, `${id}.${ext}`), buf);
  await fs.writeFile(
    path.join(AUDIO_DIR, `${id}.json`),
    JSON.stringify({ mimeType, ext, bytes: buf.length }),
    "utf-8"
  );
  return { id, url: audioUrl(id), mimeType, bytes: buf.length };
}

export interface AudioBytes {
  bytes: Buffer;
  mimeType: string;
}

/** Read a stored clip back (for GET /api/audio/[id]). Null when missing. */
export async function getAudio(id: string): Promise<AudioBytes | null> {
  const clean = safeId(id);
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(AUDIO_DIR, `${clean}.json`), "utf-8")
    ) as { mimeType: string; ext: string; storage?: string };
    if (meta.storage === "r2") {
      try {
        const { r2GetObject } = await import("./r2");
        const obj = await r2GetObject(`audio/${clean}.${meta.ext}`);
        if (obj) return { bytes: obj.bytes, mimeType: meta.mimeType };
      } catch {
        /* fall through */
      }
    }
    const bytes = await fs.readFile(path.join(AUDIO_DIR, `${clean}.${meta.ext}`));
    return { bytes, mimeType: meta.mimeType };
  } catch {
    return null;
  }
}
