// POST /api/upload — accept one or more DICOM files (multipart form-data),
// store them in the imaging archive, and return the resulting study/series
// DICOM UIDs (with cover-ready metadata) so the create-case flow can group +
// preview them.
//
// The client uploads in small batches (so a 300-slice study never sends one
// giant request) and may retry just the files that failed. Each response is
// therefore per-batch and per-file: { stored, series[], failed[], skipped[] }.
//
// Classification, the de-id gate, and STOW live in lib/uploadIngest.ts.
// requireAuthorOrg stays here and is unchanged. Pixel OCR is not claimed.
//
// Prove file: public/dicom/teach_anon_mr.dcm (identity tags blanked). The
// bundled viewer sample public/dicom/emri_small.dcm still carries
// PatientBirthDate 20000101 and is refused on purpose.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { orthancConfigured } from "@/lib/orthanc";
import { ingestUpload } from "@/lib/uploadIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let orgId: string;
  try {
    orgId = await requireAuthorOrg();
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
  if (!orthancConfigured()) {
    return NextResponse.json(
      {
        error:
          "Imaging archive isn't connected yet, so studies can't be uploaded. " +
          "You can still create the case and link imaging later.",
        code: "ORTHANC_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Couldn't read the uploaded files. Please try again." },
      { status: 400 }
    );
  }

  const result = await ingestUpload(orgId, form);
  return NextResponse.json(result.body, { status: result.status });
}
