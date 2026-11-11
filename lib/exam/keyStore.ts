import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getCaseForOrg, readExamKey, writeExamKey } from "../cases";
import type { ExamKey } from "./types";
import { ExamError } from "./types";

/** A separate, immutable server document pinned at attempt start. */
export async function snapshotExamKey(orgId: string, caseId: string): Promise<ExamKey> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data || data.status !== "published") throw new ExamError("Published case not found", 404);
  const items = data.findings.map(f => ({ id: f.id,
    phrases: (f.reportMustMention?.length ? f.reportMustMention : [f.reportGold || f.description]).filter(Boolean),
    tolerancePixels: 5,
    ...(f.sopInstanceUID && f.frameNumber && f.imagePoint ? { point: { sopUID: f.sopInstanceUID, frame: f.frameNumber, imagePoint: f.imagePoint } } : {}),
  }));
  const rubricVersion = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  const key: ExamKey = { id: randomUUID(), orgId, caseId, rubricVersion, items };
  await writeExamKey(key);
  return key;
}
export async function pinnedExamKey(orgId: string, id: string): Promise<ExamKey> {
  const key = await readExamKey(orgId, id);
  if (!key) throw new ExamError("Exam key unavailable", 409);
  return key;
}
