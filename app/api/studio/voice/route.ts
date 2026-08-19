// POST /api/studio/voice — enroll / refresh teacher voice clone (ElevenLabs)
// Body: { name?: string, sampleAudioUrls?: string[], consent: true }
// GET  /api/studio/voice — current Author.voice for the signed-in teacher

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg, requireSession } from "@/lib/auth";
import {
  getAuthor,
  listAuthors,
  updateAuthor,
} from "@/lib/cases";
import { elevenLabsCloneVoice, elevenLabsConfigured } from "@/lib/elevenlabs";
import type { AuthorVoice } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorForTeacher(orgId: string, userId: string) {
  const authors = await listAuthors(orgId);
  return (
    authors.find((a) => a.userId === userId) ??
    authors.find((a) => a.id === "auth_demo") ??
    authors[0] ??
    null
  );
}

export async function GET() {
  try {
    const session = await requireSession();
    const orgId = await requireAuthorOrg();
    const author = await authorForTeacher(orgId, session.id);
    return NextResponse.json({
      authorId: author?.id ?? null,
      voice: author?.voice ?? { provider: "elevenlabs", status: "none" },
      elevenLabsConfigured: elevenLabsConfigured(),
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const orgId = await requireAuthorOrg();
    if (!elevenLabsConfigured()) {
      return NextResponse.json(
        {
          error:
            "ELEVENLABS_API_KEY is not set. Add it to enable teacher voice cloning.",
        },
        { status: 503 }
      );
    }

    const body = (await req.json()) as {
      name?: string;
      sampleAudioUrls?: string[];
      /** base64 samples when URLs are not yet uploaded */
      samples?: Array<{ base64: string; mimeType: string; filename?: string }>;
      consent?: boolean;
    };

    if (!body.consent) {
      return NextResponse.json(
        {
          error:
            "Consent is required to create a synthetic teaching voice from your samples.",
        },
        { status: 400 }
      );
    }

    const author = await authorForTeacher(orgId, session.id);
    if (!author) {
      return NextResponse.json(
        { error: "No author profile found for this teacher." },
        { status: 404 }
      );
    }

    const samples: Array<{ bytes: Buffer; filename: string; mimeType: string }> =
      [];
    for (const s of body.samples ?? []) {
      if (!s.base64) continue;
      samples.push({
        bytes: Buffer.from(s.base64, "base64"),
        filename: s.filename || `sample_${samples.length + 1}.webm`,
        mimeType: s.mimeType || "audio/webm",
      });
    }

    // Fetch remote sample URLs when provided (same-origin /audio or R2 public).
    for (const url of body.sampleAudioUrls ?? []) {
      try {
        const abs = url.startsWith("http")
          ? url
          : new URL(url, process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000")
              .toString();
        const res = await fetch(abs);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get("content-type") || "audio/mpeg";
        samples.push({
          bytes: buf,
          filename: `sample_${samples.length + 1}.bin`,
          mimeType: mime,
        });
      } catch {
        /* skip bad URL */
      }
    }

    if (samples.length === 0) {
      return NextResponse.json(
        { error: "Provide sample audio (samples[] or sampleAudioUrls[])." },
        { status: 400 }
      );
    }

    const pending: AuthorVoice = {
      provider: "elevenlabs",
      status: "pending",
      sampleAudioUrls: body.sampleAudioUrls,
      consentAt: new Date().toISOString(),
    };
    await updateAuthor(orgId, author.id, { voice: pending });

    try {
      const { voiceId } = await elevenLabsCloneVoice({
        name: body.name?.trim() || `${author.name} (FlowRad tutor)`,
        description: `FlowRad Learn teaching voice for ${author.name}`,
        samples,
      });
      const ready: AuthorVoice = {
        ...pending,
        voiceId,
        status: "ready",
        clonedAt: new Date().toISOString(),
      };
      const updated = await updateAuthor(orgId, author.id, { voice: ready });
      if (!updated) {
        return NextResponse.json({ error: "Could not save voice." }, { status: 500 });
      }
      return NextResponse.json({ voice: updated.voice, authorId: updated.id });
    } catch (err) {
      const failed: AuthorVoice = {
        ...pending,
        status: "failed",
      };
      await updateAuthor(orgId, author.id, { voice: failed });
      throw err;
    }
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
