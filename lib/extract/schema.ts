import { assertNoPhi } from "../phiGuard";
import type { FindingVersion } from "../types";

export interface ExtractProposal {
  label: string; description: string; teachingPoints: string[];
  dictatedOrVisual: "dictated" | "visual" | "both" | null;
  evidence: FindingVersion["evidence"];
  markerId?: string;
  confidence: number | null;
}
export interface DiscardAudit { location: string; category: "identity" | "geometry" | "patient" | "unknown"; count: number }
/** Provider schema is advisory; the runtime allowlist below is the authority. */
export const EXTRACTION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["findings"], properties: {
    findings: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["label", "description", "teachingPoints", "dictatedOrVisual", "evidence", "confidence"], properties: {
        label: { type: "string" }, description: { type: "string" }, teachingPoints: { type: "array", items: { type: "string" } },
        dictatedOrVisual: { type: "string", enum: ["dictated", "visual", "both"] }, markerId: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
        evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["tStart", "tEnd", "journalSeq"], properties: {
          tStart: { type: "number" }, tEnd: { type: "number" }, journalSeq: { type: "array", items: { type: "integer" } },
        } } },
      },
    } },
  },
} as const;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const text = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
const category = (key: string): DiscardAudit["category"] => /patient|accession|birth|referring|00100010|00100020|00100030|00080050|00080090/i.test(key) ? "patient" : /uid|frame|series|study|sop/i.test(key) ? "identity" : /point|coord|measurement|spacing|window|camera|marker|annotation|slice|anchor|guide|geometry/i.test(key) ? "geometry" : "unknown";
export function parseExtraction(raw: unknown): { proposals: ExtractProposal[]; audit: DiscardAudit[] } {
  const audit: DiscardAudit[] = [];
  function discard(row: Record<string, unknown>, allowed: string[], location: string) {
    for (const key of Object.keys(row)) if (!allowed.includes(key)) {
      const kind = category(key), found = audit.find(a => a.location === location && a.category === kind);
      if (found) found.count++; else audit.push({ location, category: kind, count: 1 });
    }
  }
  const body = object(raw); discard(body, ["findings"], "response");
  if (!Array.isArray(body.findings) || body.findings.length > 100) throw new Error("Invalid extraction schema");
  const proposals = body.findings.map((value, i): ExtractProposal => {
    const row = object(value); discard(row, ["label", "description", "teachingPoints", "dictatedOrVisual", "evidence", "markerId", "confidence"], `finding:${i}`);
    if (Array.isArray(row.evidence) && row.evidence.length > 20) throw new Error("Too many evidence intervals");
    const evidence = (Array.isArray(row.evidence) ? row.evidence : []).map((value, j) => {
      const e = object(value); discard(e, ["tStart", "tEnd", "journalSeq"], `finding:${i}:evidence:${j}`);
      if (Array.isArray(e.journalSeq) && e.journalSeq.length > 256) throw new Error("Too many evidence references");
      const seq = Array.isArray(e.journalSeq) ? e.journalSeq.filter((v): v is number => Number.isInteger(v) && Number(v) >= 0) : [];
      return { tStart: finite(e.tStart), tEnd: finite(e.tEnd), journalSeq: seq,
        ...(seq.length !== (Array.isArray(e.journalSeq) ? e.journalSeq.length : 0) ? { estimated: true } : {}) };
    });
    const confidence = finite(row.confidence);
    return { label: text(row.label, 200) || `Finding ${i + 1}`, description: text(row.description, 6000),
      teachingPoints: Array.isArray(row.teachingPoints) ? row.teachingPoints.filter((v): v is string => typeof v === "string").slice(0, 20).map(v => text(v, 1000)) : [],
      dictatedOrVisual: ["dictated", "visual", "both"].includes(String(row.dictatedOrVisual)) ? row.dictatedOrVisual as ExtractProposal["dictatedOrVisual"] : null,
      evidence, confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
      ...(typeof row.markerId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(row.markerId) ? { markerId: row.markerId } : {}),
    };
  });
  assertNoPhi(proposals);
  // Fixed categories/counts only. Never log unknown field names, values or model text.
  if (audit.length) console.info("[extract.discarded]", JSON.stringify(audit));
  return { proposals, audit };
}
