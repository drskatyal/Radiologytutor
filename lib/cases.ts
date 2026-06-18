// ============================================================================
// lib/cases.ts
//
// Demo persistence: one JSON file per case. Server-only (uses fs).
//
// The store directory is DATA_DIR (env-overridable) so it can point at a
// Railway persistent Volume — that survives redeploys with no database. On an
// empty store we seed from the committed `/seed` cases so demos always have
// sample data. Swap this whole module for MongoDB later without touching callers.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import type { CaseData, Finding } from "./types";

// Mount a Railway Volume here (e.g. /app/data) and the JSON store persists.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
// Committed sample cases used to seed an empty store.
const SEED_DIR = path.join(process.cwd(), "seed");

let seeded = false;

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!seeded) {
    seeded = true;
    await seedIfEmpty();
  }
}

/** Copy committed seed cases into the store the first time it's empty. */
async function seedIfEmpty(): Promise<void> {
  try {
    const existing = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith(".json"));
    if (existing.length > 0) return;
    const seeds = await fs.readdir(SEED_DIR).catch(() => [] as string[]);
    for (const f of seeds) {
      if (f.endsWith(".json")) {
        await fs.copyFile(path.join(SEED_DIR, f), path.join(DATA_DIR, f));
      }
    }
  } catch {
    // Best-effort seeding; never block reads/writes.
  }
}

function caseFilePath(caseId: string): string {
  // Guard against path traversal — caseId becomes a filename.
  const safe = caseId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function listCases(): Promise<CaseData[]> {
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR);
  const cases: CaseData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry), "utf-8");
      cases.push(JSON.parse(raw) as CaseData);
    } catch {
      // Skip malformed files rather than crashing the list.
    }
  }
  return cases.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getCase(caseId: string): Promise<CaseData | null> {
  try {
    const raw = await fs.readFile(caseFilePath(caseId), "utf-8");
    const data = JSON.parse(raw) as CaseData;
    data.findings.sort((a, b) => a.order - b.order);
    return data;
  } catch {
    return null;
  }
}

export async function saveCase(data: CaseData): Promise<void> {
  await ensureDataDir();
  data.findings.sort((a, b) => a.order - b.order);
  await fs.writeFile(caseFilePath(data.caseId), JSON.stringify(data, null, 2), "utf-8");
}

/** Create a new (empty) case, or return the existing one if it already exists. */
export async function createCase(
  caseId: string,
  title: string,
  modality: string,
  pacsbinBaseUrl: string
): Promise<CaseData> {
  const existing = await getCase(caseId);
  if (existing) return existing;
  const data: CaseData = { caseId, title, modality, pacsbinBaseUrl, findings: [] };
  await saveCase(data);
  return data;
}

export async function addFinding(caseId: string, finding: Finding): Promise<CaseData> {
  const data = await getCase(caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  if (finding.order == null) {
    finding.order = data.findings.length + 1;
  }
  data.findings.push(finding);
  await saveCase(data);
  return data;
}

export async function updateFinding(
  caseId: string,
  findingId: string,
  patch: Partial<Finding>
): Promise<CaseData> {
  const data = await getCase(caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  const idx = data.findings.findIndex((f) => f.id === findingId);
  if (idx === -1) throw new Error(`Finding not found: ${findingId}`);
  data.findings[idx] = { ...data.findings[idx], ...patch, id: findingId };
  await saveCase(data);
  return data;
}

export async function deleteFinding(caseId: string, findingId: string): Promise<CaseData> {
  const data = await getCase(caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  data.findings = data.findings.filter((f) => f.id !== findingId);
  await saveCase(data);
  return data;
}

/** Reorder findings. `orderedIds` is the new sequence; sets `order` to index+1. */
export async function reorderFindings(
  caseId: string,
  orderedIds: string[]
): Promise<CaseData> {
  const data = await getCase(caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  const rank = new Map(orderedIds.map((id, i) => [id, i + 1]));
  for (const f of data.findings) {
    const r = rank.get(f.id);
    if (r != null) f.order = r;
  }
  await saveCase(data);
  return data;
}
