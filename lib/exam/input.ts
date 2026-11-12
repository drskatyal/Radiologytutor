import { assertNoPhi } from "../phiGuard";
import { ExamError, type ExamAnswer } from "./types";
export function parseExamAnswer(raw: unknown): ExamAnswer {
  if (!raw || typeof raw !== "object") throw new ExamError("Answer required", 400);
  const a = raw as Record<string, unknown>;
  assertNoPhi(a);
  if ("audio" in a || "inlineData" in a || "fileData" in a) throw new ExamError("Audio answers require a reviewed transcript", 422);
  if ((a.kind === "text" || a.kind === "report") && typeof a.text === "string" && a.text.trim() && a.text.length <= 20000) return { kind: a.kind, text: a.text.trim() };
  if (a.kind === "point" && typeof a.sopUID === "string" && Number.isInteger(a.frame) && Number(a.frame) >= 1 && a.imagePoint && typeof a.imagePoint === "object") {
    const p = a.imagePoint as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0) return { kind: "point", sopUID: a.sopUID, frame: Number(a.frame), imagePoint: { x: p.x, y: p.y } };
  }
  throw new ExamError("Invalid answer", 400);
}
