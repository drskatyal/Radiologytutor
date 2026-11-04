// Store one anonymised instance (raw Part-10 body, Content-Type application/dicom).
//
// The browser already anonymised it (lib/cloud/anonymize.ts). This route does
// not trust that: it re-runs the identity gate (lib/deid.ts), requires the
// anonymiser's markers and 2.25 UIDs, and checks that the instance belongs to
// the study record the caller owns. Only then does it STOW to the archive.

import { NextResponse, type NextRequest } from "next/server";
import { jsonError } from "@/lib/cloud/auth";
import { ownedStudy, requireAccount } from "@/lib/cloud/api";
import { archiveConfigured, stowInstance } from "@/lib/cloud/archive";
import { instanceRefusal } from "@/lib/cloud/ingestGate";
import { MAX_INSTANCE_BYTES } from "@/lib/cloud/studyInput";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { user } = await requireAccount();
    const study = await ownedStudy(params.id, user.id);
    if (!archiveConfigured()) {
      return NextResponse.json({ error: "Study storage is not configured on this server." }, { status: 503 });
    }
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_INSTANCE_BYTES) {
      return NextResponse.json({ error: "This image is larger than 30 MB and cannot be stored yet." }, { status: 413 });
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > MAX_INSTANCE_BYTES) {
      return NextResponse.json({ error: "This image is larger than 30 MB and cannot be stored yet." }, { status: 413 });
    }
    const refusal = instanceRefusal(bytes, study.studyInstanceUID);
    if (refusal) return NextResponse.json({ error: refusal }, { status: 422 });
    await stowInstance(bytes);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
