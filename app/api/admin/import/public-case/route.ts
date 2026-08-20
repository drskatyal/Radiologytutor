// POST /api/admin/import/public-case — download TCIA DICOM (or link existing
// Orthanc study), ingest, and create a published teaching case with findings.
//
// Radiopaedia does not provide a case-download API; teaching text is authored
// with Radiopaedia references while pixels come from TCIA public collections.

import { NextRequest, NextResponse } from "next/server";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import {
  importAllPublicCases,
  importPublicCase,
} from "@/lib/dicomImport/importPublicCase";
import { listPublicCaseTemplates } from "@/lib/publicCases/catalog";
import { orthancConfigured } from "@/lib/orthanc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAuthorOrg();
    return NextResponse.json({
      orthancConfigured: orthancConfigured(),
      templates: listPublicCaseTemplates().map((t) => ({
        caseId: t.caseId,
        title: t.title,
        modality: t.modality,
        source: t.source.kind,
        collection: t.source.kind === "tcia" ? t.source.collection : undefined,
        findingCount: t.findings.length,
      })),
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const orgId = await requireAuthorOrg();
    if (!orthancConfigured()) {
      return NextResponse.json(
        {
          error: "Orthanc is not configured (set ORTHANC_URL). Real DICOM import requires Orthanc.",
          code: "ORTHANC_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      caseId?: string;
      importAll?: boolean;
      force?: boolean;
      publish?: boolean;
    };

    if (body.importAll) {
      const result = await importAllPublicCases({
        orgId,
        force: body.force,
        publish: body.publish ?? true,
      });
      return NextResponse.json(result);
    }

    if (!body.caseId) {
      return NextResponse.json(
        { error: "Provide caseId or importAll: true" },
        { status: 400 }
      );
    }

    const result = await importPublicCase(body.caseId, {
      orgId,
      force: body.force,
      publish: body.publish ?? true,
    });
    return NextResponse.json(result);
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
