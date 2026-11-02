// POST /api/cases/[caseId]/sketch-export
// Teacher sketches + finding markers → DICOM SR (TID 1500), GSPS, or a JSON
// sidecar with timing and narration links.
//
// Body: { format: "sr" | "gsps" | "json",
//         items?: TeacherSketchItem[]   // the Studio's live sketch (unsaved take)
//         events?: RecordedEvent[]      // the take's timeline, for timing + links
//         narration?: NarrationSpan[], durationMs?, studyInstanceUID? }
// With no `items`, the case's saved takes are exported (capture sessions and
// finding tracks). Patient/study attributes are copied from a referenced
// instance in the archive so the SR files under the same study; the archive
// read is best-effort. Author role, org-scoped; the case must be in the org.

import { NextRequest, NextResponse } from "next/server";
import dcmjs from "dcmjs";
import { jsonAuthError, requireAuthorOrg } from "@/lib/auth";
import { getCaseForOrg } from "@/lib/cases";
import { fetchSeriesSampleDicom, orthancConfigured } from "@/lib/orthanc";
import {
  exportSketchGsps,
  exportSketchSr,
  type SketchExportContext,
} from "@/lib/dicomExport/sketchDicom";
import { buildSketchSidecar } from "@/lib/dicomExport/sketchSidecar";
import { cleanSketchItem, isSketchEvent, sketchItemsOf, sketchTimeline } from "@/lib/teacherSketch";
import type { NarrationSpan, RecordedEvent, RecordedTrack, TeacherSketchItem } from "@/lib/types";

export const runtime = "nodejs";

type Format = "sr" | "gsps" | "json";

function cleanEvents(raw: unknown): RecordedEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordedEvent[] = [];
  for (const e of raw.slice(0, 20_000)) {
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    if (ev.type !== "sketch" || typeof ev.t !== "number" || !Number.isFinite(ev.t)) continue;
    if (ev.op === "add") {
      const item = cleanSketchItem(ev.item);
      if (item) out.push({ t: ev.t, type: "sketch", op: "add", item });
    } else if (ev.op === "remove" && typeof ev.id === "string") {
      out.push({ t: ev.t, type: "sketch", op: "remove", id: ev.id });
    } else if (ev.op === "label" && typeof ev.id === "string" && typeof ev.text === "string") {
      out.push({ t: ev.t, type: "sketch", op: "label", id: ev.id, text: ev.text.slice(0, 140) });
    } else if (ev.op === "reset" && Array.isArray(ev.items)) {
      out.push({
        t: ev.t,
        type: "sketch",
        op: "reset",
        items: ev.items.map(cleanSketchItem).filter((i): i is TeacherSketchItem => !!i),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function cleanNarration(raw: unknown): NarrationSpan[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is NarrationSpan => !!s && typeof s === "object" && typeof (s as NarrationSpan).text === "string")
    .map((s) => ({ tStartMs: Number(s.tStartMs) || 0, tEndMs: Number(s.tEndMs) || 0, text: s.text.slice(0, 2000) }));
}

function pickStudy(items: TeacherSketchItem[], fallback?: string): string | undefined {
  const counts = new Map<string, number>();
  for (const item of items) {
    const uid = item.image.studyInstanceUID;
    if (uid) counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [uid, c] of counts) if (c > n) [best, n] = [uid, c];
  return best ?? fallback;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === "object" && "Alphabetic" in v) return str((v as { Alphabetic?: unknown }).Alphabetic);
  return undefined;
}

/** Patient / study module from one referenced instance. Never throws. */
async function archiveContext(studyUID: string, seriesUID: string | undefined): Promise<Partial<SketchExportContext>> {
  if (!seriesUID || !orthancConfigured()) return {};
  try {
    const bytes = await fetchSeriesSampleDicom(studyUID, seriesUID);
    if (!bytes) return {};
    const file = dcmjs.data.DicomMessage.readFile(bytes, { untilTag: "7FE00010" });
    const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(file.dict);
    return {
      patientName: str(ds.PatientName),
      patientID: str(ds.PatientID),
      patientBirthDate: str(ds.PatientBirthDate),
      patientSex: str(ds.PatientSex),
      studyDate: str(ds.StudyDate),
      studyTime: str(ds.StudyTime),
      studyID: str(ds.StudyID),
      accessionNumber: str(ds.AccessionNumber),
      referringPhysicianName: str(ds.ReferringPhysicianName),
      sopClassUID: str(ds.SOPClassUID),
      frameOfReferenceUID: str(ds.FrameOfReferenceUID),
      columns: Number(ds.Columns) || undefined,
      rows: Number(ds.Rows) || undefined,
    };
  } catch {
    return {};
  }
}

function savedTakes(tracks: (RecordedTrack | undefined)[]): { items: TeacherSketchItem[]; events: RecordedEvent[]; narration: NarrationSpan[]; durationMs?: number } {
  const byId = new Map<string, TeacherSketchItem>();
  let events: RecordedEvent[] = [];
  let narration: NarrationSpan[] = [];
  let durationMs: number | undefined;
  for (const track of tracks) {
    if (!track?.events?.some(isSketchEvent)) continue;
    for (const item of sketchItemsOf(track)) byId.set(item.id, item);
    // The longest take carries the timeline for the sidecar.
    if (sketchTimeline(track.events).length > sketchTimeline(events).length) {
      events = track.events.filter(isSketchEvent);
      narration = track.narration ?? [];
      durationMs = track.durationMs;
    }
  }
  return { items: [...byId.values()], events, narration, durationMs };
}

export async function POST(req: NextRequest, { params }: { params: { caseId: string } }) {
  try {
    const orgId = await requireAuthorOrg();
    const caseData = await getCaseForOrg(orgId, params.caseId);
    if (!caseData) return NextResponse.json({ error: "Case not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const format = (["sr", "gsps", "json"] as Format[]).includes(body.format as Format) ? (body.format as Format) : null;
    if (!format) return NextResponse.json({ error: "format must be sr, gsps, or json" }, { status: 400 });

    let items: TeacherSketchItem[] = [];
    let events: RecordedEvent[] = [];
    let narration: NarrationSpan[] = [];
    let durationMs: number | undefined;
    if (Array.isArray(body.items) && body.items.length) {
      items = body.items.slice(0, 400).map(cleanSketchItem).filter((i): i is TeacherSketchItem => !!i);
      events = cleanEvents(body.events);
      narration = cleanNarration(body.narration);
      durationMs = Number(body.durationMs) || undefined;
    } else {
      const saved = savedTakes([
        ...(caseData.captureSessions ?? []).map((s) => s.track),
        ...caseData.findings.map((f) => f.track),
      ]);
      ({ items, events, narration, durationMs } = saved);
    }
    if (!items.length) {
      return NextResponse.json({ error: "No sketches or markers to export yet." }, { status: 422 });
    }

    const study = pickStudy(
      items,
      typeof body.studyInstanceUID === "string" ? body.studyInstanceUID : caseData.studyRefs?.[0]?.studyInstanceUID
    );
    const timing: Record<string, number> = {};
    for (const row of sketchTimeline(events)) timing[row.id] = row.tMs;

    if (format === "json") {
      const sidecar = buildSketchSidecar({ caseId: caseData.caseId, items, events, narration, durationMs });
      return new NextResponse(JSON.stringify(sidecar, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${caseData.caseId}-sketch.json"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (!study) {
      return NextResponse.json(
        { error: "These marks are on images without a DICOM study UID (sample or local files), so they can't be exported as DICOM." },
        { status: 422 }
      );
    }
    const firstSeries = items.find((i) => i.image.studyInstanceUID === study)?.image.seriesInstanceUID ?? items[0]?.image.seriesInstanceUID;
    const ctx: SketchExportContext = { studyInstanceUID: study, ...(await archiveContext(study, firstSeries)) };
    const result = format === "sr" ? exportSketchSr(items, ctx, { timing: { tMs: timing } }) : exportSketchGsps(items, ctx);
    if (!result.written.length) {
      return NextResponse.json(
        { error: "None of the marks could be placed on a DICOM image.", skipped: result.skipped },
        { status: 422 }
      );
    }
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": "application/dicom",
        "Content-Disposition": `attachment; filename="${caseData.caseId}-sketch-${format}.dcm"`,
        "Cache-Control": "no-store",
        "X-FlowRad-Written": String(result.written.length),
        "X-FlowRad-Skipped": String(result.skipped.length),
        "X-FlowRad-SOP-Instance-UID": result.sopInstanceUID,
      },
    });
  } catch (err) {
    const denied = jsonAuthError(err);
    if (denied) return denied;
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
