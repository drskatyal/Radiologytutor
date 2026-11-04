// Owner download: my stored study as a ZIP of anonymised DICOM.

import type { NextRequest } from "next/server";
import { HttpError, jsonError } from "@/lib/cloud/auth";
import { ownedStudy, requireAccount } from "@/lib/cloud/api";
import { studyZipResponse } from "@/lib/cloud/studyDownload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { user } = await requireAccount();
    const study = await ownedStudy(params.id, user.id);
    if (study.status !== "ready") throw new HttpError(409, "This study is still uploading.");
    return studyZipResponse(study);
  } catch (err) {
    return jsonError(err);
  }
}
