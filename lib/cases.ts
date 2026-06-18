// ============================================================================
// lib/cases.ts
//
// The data layer for FlowRad Learn. Every read/write of a Case, Patient, Study
// or Finding goes through here. Callers NEVER touch the underlying store, so we
// can move from JSON-on-volume (today) to MongoDB (later) without changing a
// single call site.
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │  MONGODB-SWAP SEAM                                                     │
//   │  The only store-specific code lives in the `JsonCollection` class and │
//   │  the `collection<T>()` factory below (marked "STORE SEAM"). To move   │
//   │  to MongoDB, reimplement that one class against a Mongo collection    │
//   │  (find/findOne/insertOne/updateOne/deleteOne) and have `collection()` │
//   │  return it. The exported API functions stay byte-for-byte identical.  │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Multi-tenancy: everything is scoped by `orgId` (CLAUDE.md §4a). Auth is a
// seam now (single demo org); the exported functions already take/derive an
// `orgId` so real auth slots in without a refactor.
//
// The store directory is DATA_DIR (env-overridable) so it can point at a
// Railway persistent Volume — that survives redeploys with no database. On an
// empty store we seed from the committed `/seed` cases so demos always have
// sample data.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import type {
  CaseData,
  Case,
  CaseStatus,
  CaseStudyRef,
  Finding,
  Patient,
  Study,
} from "./types";

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/** The single demo tenant used until real auth lands. Every entity is scoped
 *  to an org; callers that don't yet have a session derive this default. */
export const DEFAULT_ORG_ID = "org_demo";

// ---------------------------------------------------------------------------
// Paths / config
// ---------------------------------------------------------------------------

// Mount a Railway Volume here (e.g. /app/data) and the JSON store persists.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
// Committed sample cases used to seed an empty store.
const SEED_DIR = path.join(process.cwd(), "seed");

// ============================================================================
// STORE SEAM — JSON-on-volume implementation.
//
// A `Collection<T>` is the minimal persistence surface the data layer needs.
// Records are plain JSON objects with a string `id`. Each collection is one
// subdirectory under DATA_DIR with one `<id>.json` file per record. Cases keep
// living at DATA_DIR/<caseId>.json (back-compat with the original layout) by
// using "" as their subdirectory.
//
// To swap to MongoDB: implement this same interface over a Mongo collection
// and return it from `collection()`. Nothing else in this file changes.
// ============================================================================

interface Collection<T extends { id: string }> {
  all(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(record: T): Promise<T>;
  remove(id: string): Promise<boolean>;
}

let dataDirReady: Promise<void> | null = null;

/** Idempotently ensure DATA_DIR exists and is seeded once per process. */
function ensureDataDir(): Promise<void> {
  if (!dataDirReady) {
    dataDirReady = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await seedIfEmpty();
    })();
  }
  return dataDirReady;
}

/**
 * Copy committed seed data into the store the first time it's empty. Mirrors
 * the store layout: case JSON at the SEED_DIR root, plus `patients/` and
 * `studies/` subdirectories so a seeded case has its Patient + Study.
 */
async function seedIfEmpty(): Promise<void> {
  try {
    const existing = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith(".json"));
    if (existing.length > 0) return;
    // Cases live at the root.
    await copyJsonFiles(SEED_DIR, DATA_DIR);
    // Entity subdirectories (patients, studies) mirror the store layout.
    for (const sub of ["patients", "studies"] as const) {
      const src = path.join(SEED_DIR, sub);
      const dst = path.join(DATA_DIR, sub);
      await fs.mkdir(dst, { recursive: true });
      await copyJsonFiles(src, dst);
    }
  } catch {
    // Best-effort seeding; never block reads/writes.
  }
}

/** Copy every top-level *.json from `src` into `dst`. Tolerates a missing src. */
async function copyJsonFiles(src: string, dst: string): Promise<void> {
  const files = await fs.readdir(src).catch(() => [] as string[]);
  for (const f of files) {
    if (f.endsWith(".json")) {
      await fs.copyFile(path.join(src, f), path.join(dst, f));
    }
  }
}

/** Sanitize an id so it can safely become a filename (no path traversal). */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

class JsonCollection<T extends { id: string }> implements Collection<T> {
  /** "" keeps cases at the DATA_DIR root (original layout); others nest. */
  constructor(private readonly subdir: string) {}

  private dir(): string {
    return this.subdir ? path.join(DATA_DIR, this.subdir) : DATA_DIR;
  }

  private file(id: string): string {
    return path.join(this.dir(), `${safeId(id)}.json`);
  }

  private async ready(): Promise<void> {
    await ensureDataDir();
    if (this.subdir) await fs.mkdir(this.dir(), { recursive: true });
  }

  async all(): Promise<T[]> {
    await this.ready();
    const entries = await fs.readdir(this.dir()).catch(() => [] as string[]);
    const records: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir(), entry), "utf-8");
        records.push(JSON.parse(raw) as T);
      } catch {
        // Skip malformed files rather than crashing the list.
      }
    }
    return records;
  }

  async get(id: string): Promise<T | null> {
    await this.ready();
    try {
      const raw = await fs.readFile(this.file(id), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async put(record: T): Promise<T> {
    await this.ready();
    await fs.writeFile(this.file(record.id), JSON.stringify(record, null, 2), "utf-8");
    return record;
  }

  async remove(id: string): Promise<boolean> {
    await this.ready();
    try {
      await fs.unlink(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}

/** STORE SEAM: the one factory to reimplement when moving to MongoDB. */
function collection<T extends { id: string }>(
  name: "cases" | "patients" | "studies"
): Collection<T> {
  // Cases live at the DATA_DIR root (subdir "") for back-compat with the
  // original one-file-per-case layout; other entities nest in a subdirectory.
  return new JsonCollection<T>(name === "cases" ? "" : name);
}

/** On disk a case keeps `caseId`; we mirror it to `id` for the collection. */
type CaseStored = Case & { id: string };

// Internal collections.
const patients = collection<Patient>("patients");
const studies = collection<Study>("studies");
const casesStore = collection<CaseStored>("cases");

function toStored(c: Case): CaseStored {
  return { ...c, id: c.caseId };
}

/** Normalize any persisted case (old seed shape or new) into a full `Case`. */
function normalizeCase(raw: CaseData & Partial<Case>): Case {
  const now = new Date().toISOString();
  const findings = (raw.findings ?? []).slice().sort((a, b) => a.order - b.order);
  return {
    ...raw,
    findings,
    orgId: raw.orgId ?? DEFAULT_ORG_ID,
    status: raw.status ?? "published",
    studyRefs: raw.studyRefs,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ============================================================================
// Legacy/back-compat API — original signatures, still used by existing routes
// and UI. These operate on the default org. Persisting through them is lossless
// because `Case` is a superset of `CaseData`.
// ============================================================================

export async function listCases(): Promise<CaseData[]> {
  const all = await casesStore.all();
  return all
    .map(normalizeCase)
    .sort((a, b) => a.title.localeCompare(b.title)) as CaseData[];
}

export async function getCase(caseId: string): Promise<CaseData | null> {
  const raw = await casesStore.get(caseId);
  return raw ? normalizeCase(raw) : null;
}

export async function saveCase(data: CaseData): Promise<void> {
  const full = normalizeCase({ ...(data as Case) });
  full.updatedAt = nowIso();
  await casesStore.put(toStored(full));
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
  const now = nowIso();
  const data: Case = {
    caseId,
    title,
    modality,
    pacsbinBaseUrl,
    findings: [],
    orgId: DEFAULT_ORG_ID,
    status: "published",
    createdAt: now,
    updatedAt: now,
  };
  await casesStore.put(toStored(data));
  return data;
}

export async function addFinding(caseId: string, finding: Finding): Promise<CaseData> {
  return createFinding(DEFAULT_ORG_ID, caseId, finding);
}

export async function updateFinding(
  caseId: string,
  findingId: string,
  patch: Partial<Finding>
): Promise<CaseData> {
  return updateFindingScoped(DEFAULT_ORG_ID, caseId, findingId, patch);
}

export async function deleteFinding(caseId: string, findingId: string): Promise<CaseData> {
  return deleteFindingScoped(DEFAULT_ORG_ID, caseId, findingId);
}

/** Reorder findings. `orderedIds` is the new sequence; sets `order` to index+1. */
export async function reorderFindings(
  caseId: string,
  orderedIds: string[]
): Promise<CaseData> {
  return reorderFindingsScoped(DEFAULT_ORG_ID, caseId, orderedIds);
}

// ============================================================================
// orgId-scoped Case API (CLAUDE.md §4a)
// ============================================================================

export interface ListCasesOptions {
  /** Filter by publication status. Omit for all. */
  status?: CaseStatus;
  /** Only cases teaching from this patient. */
  patientId?: string;
}

/** List an org's cases, newest-updated first, with optional status filter. */
export async function listCasesForOrg(
  orgId: string,
  opts: ListCasesOptions = {}
): Promise<Case[]> {
  const all = (await casesStore.all()).map(normalizeCase);
  return all
    .filter((c) => c.orgId === orgId)
    .filter((c) => (opts.status ? c.status === opts.status : true))
    .filter((c) => (opts.patientId ? c.patientId === opts.patientId : true))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Get a single case, enforcing tenant ownership. */
export async function getCaseForOrg(orgId: string, caseId: string): Promise<Case | null> {
  const raw = await casesStore.get(caseId);
  if (!raw) return null;
  const c = normalizeCase(raw);
  return c.orgId === orgId ? c : null;
}

export interface CreateCaseInput {
  caseId?: string;
  title: string;
  modality: string;
  pacsbinBaseUrl: string;
  patientId?: string;
  specialty?: string;
  status?: CaseStatus;
  studyRefs?: CaseStudyRef[];
}

/** Create a new case under an org. Returns the created entity. */
export async function createCaseForOrg(orgId: string, input: CreateCaseInput): Promise<Case> {
  const caseId = input.caseId ? safeId(input.caseId) : genId("case");
  const now = nowIso();
  const data: Case = {
    caseId,
    title: input.title,
    modality: input.modality,
    pacsbinBaseUrl: input.pacsbinBaseUrl,
    findings: [],
    orgId,
    patientId: input.patientId,
    specialty: input.specialty,
    status: input.status ?? "draft",
    studyRefs: input.studyRefs,
    createdAt: now,
    updatedAt: now,
  };
  await casesStore.put(toStored(data));
  return data;
}

/** Fields a case update may change. `findings` is managed via the finding API. */
export type UpdateCaseInput = Partial<
  Pick<
    Case,
    "title" | "modality" | "pacsbinBaseUrl" | "patientId" | "specialty" | "status" | "studyRefs"
  >
>;

/** Patch a case's metadata. Returns the updated entity (or null if not found). */
export async function updateCaseForOrg(
  orgId: string,
  caseId: string,
  patch: UpdateCaseInput
): Promise<Case | null> {
  const current = await getCaseForOrg(orgId, caseId);
  if (!current) return null;
  const updated: Case = { ...current, ...patch, caseId, orgId, updatedAt: nowIso() };
  await casesStore.put(toStored(updated));
  return updated;
}

/** Delete a case (tenant-checked). Returns true if a case was removed. */
export async function deleteCaseForOrg(orgId: string, caseId: string): Promise<boolean> {
  const current = await getCaseForOrg(orgId, caseId);
  if (!current) return false;
  return casesStore.remove(caseId);
}

// ============================================================================
// orgId-scoped Finding API
// ============================================================================

/** Append a finding to a case. Returns the updated case. */
export async function createFinding(
  orgId: string,
  caseId: string,
  finding: Finding
): Promise<Case> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  const f: Finding = { ...finding };
  if (f.order == null) f.order = data.findings.length + 1;
  data.findings.push(f);
  data.findings.sort((a, b) => a.order - b.order);
  data.updatedAt = nowIso();
  await casesStore.put(toStored(data));
  return data;
}

/** Patch one finding's fields. Returns the updated case. */
export async function updateFindingScoped(
  orgId: string,
  caseId: string,
  findingId: string,
  patch: Partial<Finding>
): Promise<Case> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  const idx = data.findings.findIndex((f) => f.id === findingId);
  if (idx === -1) throw new Error(`Finding not found: ${findingId}`);
  data.findings[idx] = { ...data.findings[idx], ...patch, id: findingId };
  data.findings.sort((a, b) => a.order - b.order);
  data.updatedAt = nowIso();
  await casesStore.put(toStored(data));
  return data;
}

/** Delete one finding. Returns the updated case. */
export async function deleteFindingScoped(
  orgId: string,
  caseId: string,
  findingId: string
): Promise<Case> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  data.findings = data.findings.filter((f) => f.id !== findingId);
  data.updatedAt = nowIso();
  await casesStore.put(toStored(data));
  return data;
}

/** Reorder findings; `orderedIds` is the new sequence (sets order to index+1). */
export async function reorderFindingsScoped(
  orgId: string,
  caseId: string,
  orderedIds: string[]
): Promise<Case> {
  const data = await getCaseForOrg(orgId, caseId);
  if (!data) throw new Error(`Case not found: ${caseId}`);
  const rank = new Map(orderedIds.map((id, i) => [id, i + 1]));
  for (const f of data.findings) {
    const r = rank.get(f.id);
    if (r != null) f.order = r;
  }
  data.findings.sort((a, b) => a.order - b.order);
  data.updatedAt = nowIso();
  await casesStore.put(toStored(data));
  return data;
}

// ============================================================================
// orgId-scoped Patient API
// ============================================================================

export async function listPatients(orgId: string): Promise<Patient[]> {
  const all = await patients.all();
  return all
    .filter((p) => p.orgId === orgId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getPatient(orgId: string, patientId: string): Promise<Patient | null> {
  const p = await patients.get(patientId);
  return p && p.orgId === orgId ? p : null;
}

export interface CreatePatientInput {
  id?: string;
  displayName: string;
  mrnHash?: string;
}

export async function createPatient(orgId: string, input: CreatePatientInput): Promise<Patient> {
  const now = nowIso();
  const patient: Patient = {
    id: input.id ? safeId(input.id) : genId("pat"),
    orgId,
    displayName: input.displayName,
    mrnHash: input.mrnHash,
    createdAt: now,
    updatedAt: now,
  };
  await patients.put(patient);
  return patient;
}

export async function updatePatient(
  orgId: string,
  patientId: string,
  patch: Partial<Pick<Patient, "displayName" | "mrnHash">>
): Promise<Patient | null> {
  const current = await getPatient(orgId, patientId);
  if (!current) return null;
  const updated: Patient = { ...current, ...patch, id: patientId, orgId, updatedAt: nowIso() };
  await patients.put(updated);
  return updated;
}

export async function deletePatient(orgId: string, patientId: string): Promise<boolean> {
  const current = await getPatient(orgId, patientId);
  if (!current) return false;
  return patients.remove(patientId);
}

// ============================================================================
// orgId-scoped Study API + patient chronology
// ============================================================================

export async function listStudies(orgId: string, patientId?: string): Promise<Study[]> {
  const all = await studies.all();
  return all
    .filter((s) => s.orgId === orgId)
    .filter((s) => (patientId ? s.patientId === patientId : true));
}

export async function getStudy(orgId: string, studyId: string): Promise<Study | null> {
  const s = await studies.get(studyId);
  return s && s.orgId === orgId ? s : null;
}

/** Find a study by its DICOM StudyInstanceUID within an org. */
export async function getStudyByUID(
  orgId: string,
  studyInstanceUID: string
): Promise<Study | null> {
  const all = await studies.all();
  return all.find((s) => s.orgId === orgId && s.studyInstanceUID === studyInstanceUID) ?? null;
}

export interface CreateStudyInput {
  id?: string;
  patientId: string;
  studyInstanceUID: string;
  studyDate?: string;
  modality?: string;
  description?: string;
  orthancStudyId?: string;
  seriesInstanceUIDs?: string[];
}

export async function createStudy(orgId: string, input: CreateStudyInput): Promise<Study> {
  const now = nowIso();
  const study: Study = {
    id: input.id ? safeId(input.id) : genId("stu"),
    orgId,
    patientId: input.patientId,
    studyInstanceUID: input.studyInstanceUID,
    studyDate: input.studyDate,
    modality: input.modality,
    description: input.description,
    orthancStudyId: input.orthancStudyId,
    seriesInstanceUIDs: input.seriesInstanceUIDs ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await studies.put(study);
  return study;
}

export async function updateStudy(
  orgId: string,
  studyId: string,
  patch: Partial<
    Pick<
      Study,
      | "studyDate"
      | "modality"
      | "description"
      | "orthancStudyId"
      | "seriesInstanceUIDs"
      | "patientId"
    >
  >
): Promise<Study | null> {
  const current = await getStudy(orgId, studyId);
  if (!current) return null;
  const updated: Study = { ...current, ...patch, id: studyId, orgId, updatedAt: nowIso() };
  await studies.put(updated);
  return updated;
}

export async function deleteStudy(orgId: string, studyId: string): Promise<boolean> {
  const current = await getStudy(orgId, studyId);
  if (!current) return false;
  return studies.remove(studyId);
}

/**
 * Patient chronology: a patient's studies ordered by studyDate (ascending, so
 * oldest "prior" first, newest "current" last). Studies without a date sort to
 * the end. This is what the UI uses to lay out "prior vs current".
 */
export async function listStudiesChronological(
  orgId: string,
  patientId: string
): Promise<Study[]> {
  const list = await listStudies(orgId, patientId);
  return list.sort((a, b) => {
    if (a.studyDate && b.studyDate) return a.studyDate.localeCompare(b.studyDate);
    if (a.studyDate) return -1;
    if (b.studyDate) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}
