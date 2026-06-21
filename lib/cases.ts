// ============================================================================
// lib/cases.ts
//
// The data layer for FlowRad Learn. Every read/write of a Case, Patient, Study
// or Finding goes through here. Callers NEVER touch the underlying store, so we
// can move from JSON-on-volume (today) to MongoDB (later) without changing a
// single call site.
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │  MONGODB-SWAP SEAM (realized)                                          │
//   │  The only store-specific code lives in the `JsonCollection` /         │
//   │  `MongoCollection` classes and the `collection<T>()` factory below    │
//   │  (marked "STORE SEAM"). Both classes implement the SAME `Collection`  │
//   │  interface (all/get/put/remove). The factory picks one at runtime:    │
//   │  if `MONGODB_URI` is configured -> MongoCollection, else the default  │
//   │  JsonCollection (JSON-on-volume). The exported API functions below    │
//   │  stay byte-for-byte identical regardless of which store is active.    │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Multi-tenancy: everything is scoped by `orgId` (CLAUDE.md §4a). Auth is a
// seam now (single demo org); the exported functions already take/derive an
// `orgId` so real auth slots in without a refactor.
//
// Store selection is ENV-GATED and LAZY: with no `MONGODB_URI` the app uses the
// JSON-on-volume store under DATA_DIR (env-overridable) so it can point at a
// Railway persistent Volume that survives redeploys with no database. Set
// `MONGODB_URI` and the entire data layer silently runs on MongoDB instead —
// no caller changes. Either store seeds itself from the committed `/seed` cases
// the first time it is empty, so demos always have sample data.
// ============================================================================

import { promises as fs } from "fs";
import path from "path";
import type { Collection as MongoNativeCollection } from "mongodb";
import type {
  CaseData,
  Case,
  CaseStatus,
  CaseStudyRef,
  Finding,
  Patient,
  Study,
  Author,
  Course,
  Playlist,
  Difficulty,
  BodySystem,
  PatientSex,
  TargetLevel,
} from "./types";
import { ensureIndexes, getDb, mongoConfigured } from "./mongo";

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
    // Cases live at the DATA_DIR root — seed only if there are none.
    const rootJson = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith(".json"));
    if (rootJson.length === 0) await copyJsonFiles(SEED_DIR, DATA_DIR);
    // Each entity subdir seeds INDEPENDENTLY if it is empty — so a store that
    // predates a collection (e.g. an existing volume from before courses
    // existed) still gets that collection's seed data on next boot.
    for (const sub of ["patients", "studies", "authors", "courses", "playlists"] as const) {
      const dst = path.join(DATA_DIR, sub);
      await fs.mkdir(dst, { recursive: true });
      const existing = (await fs.readdir(dst)).filter((f) => f.endsWith(".json"));
      if (existing.length === 0) await copyJsonFiles(path.join(SEED_DIR, sub), dst);
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

type CollectionName =
  | "cases"
  | "patients"
  | "studies"
  | "authors"
  | "courses"
  | "playlists";

/**
 * Read and parse every committed seed record for one logical collection. Cases
 * live at the SEED_DIR root (back-compat layout); patients/studies nest in a
 * subdirectory. Used by the MongoDB store to seed an empty DB the same way the
 * JSON store copies files. Tolerates a missing directory / malformed file.
 */
async function readSeedRecords<T extends { id: string }>(name: CollectionName): Promise<T[]> {
  const dir = name === "cases" ? SEED_DIR : path.join(SEED_DIR, name);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const records: T[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const parsed = JSON.parse(raw) as Partial<T> & { id?: string; caseId?: string };
      // Cases are keyed by caseId on disk; mirror it to `id` for the store.
      const id = parsed.id ?? parsed.caseId;
      if (id) records.push({ ...(parsed as T), id });
    } catch {
      // Skip malformed seed files rather than aborting the whole seed.
    }
  }
  return records;
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

// ============================================================================
// STORE SEAM — MongoDB implementation (env-gated; active when MONGODB_URI set).
//
// Implements the SAME `Collection<T>` interface as JsonCollection over a native
// Mongo collection. We use our string `id` as the Mongo `_id` so there is no
// extra mapping table — `_id` and `id` are the same value. Records already carry
// `orgId`, so tenant scoping (done by the API functions below) is unchanged.
//
// Connection is lazy: the MongoClient only connects on the first read/write
// (never at import/build time). On first use we ensure indexes and seed an empty
// DB from the committed `/seed` data, mirroring JsonCollection's seedIfEmpty.
// ============================================================================

/** Records as stored in Mongo: our string `id` doubles as the `_id`. */
type MongoDoc<T> = Omit<T, "id"> & { _id: string };

// One-process guards so we only ensure indexes / seed once across all three
// collections (not once per collection).
let mongoInitReady: Promise<void> | null = null;

/** Ensure indexes exist and the DB is seeded if empty (idempotent, once). */
function ensureMongoReady(): Promise<void> {
  if (!mongoInitReady) {
    mongoInitReady = (async () => {
      await ensureIndexes();
      await seedMongoIfEmpty();
    })().catch((err) => {
      // Allow a later call to retry (e.g. transient connection failure).
      mongoInitReady = null;
      throw err;
    });
  }
  return mongoInitReady;
}

/** Seed an empty Mongo `cases` collection from committed `/seed` data. */
async function seedMongoIfEmpty(): Promise<void> {
  const db = await getDb();
  // Seed each collection INDEPENDENTLY if it is empty — so a DB that predates a
  // collection (e.g. courses/playlists added later) still gets its seed data,
  // while never duplicating an already-populated collection.
  for (const name of [
    "cases",
    "patients",
    "studies",
    "authors",
    "courses",
    "playlists",
  ] as const) {
    const count = await db.collection(name).estimatedDocumentCount();
    if (count > 0) continue;
    const records = await readSeedRecords<{ id: string }>(name);
    if (records.length === 0) continue;
    const docs = records.map(({ id, ...rest }) => ({ _id: id, ...rest }));
    // Idempotent under races: ignore duplicate-key on _id if two invocations
    // seed concurrently.
    await db
      .collection(name)
      .insertMany(docs as never[], { ordered: false })
      .catch(() => undefined);
  }
}

class MongoCollection<T extends { id: string }> implements Collection<T> {
  constructor(private readonly name: CollectionName) {}

  private async coll(): Promise<MongoNativeCollection<MongoDoc<T>>> {
    await ensureMongoReady();
    const db = await getDb();
    return db.collection<MongoDoc<T>>(this.name);
  }

  /** Map a stored Mongo doc back to our domain record (`_id` -> `id`). */
  private fromDoc(doc: MongoDoc<T>): T {
    const { _id, ...rest } = doc;
    return { ...rest, id: _id } as unknown as T;
  }

  async all(): Promise<T[]> {
    const coll = await this.coll();
    const docs = await coll.find({}).toArray();
    return docs.map((d) => this.fromDoc(d as MongoDoc<T>));
  }

  async get(id: string): Promise<T | null> {
    const coll = await this.coll();
    const doc = await coll.findOne({ _id: id } as never);
    return doc ? this.fromDoc(doc as MongoDoc<T>) : null;
  }

  async put(record: T): Promise<T> {
    const coll = await this.coll();
    const { id, ...rest } = record;
    // Upsert by _id so create and update share one code path (like writeFile).
    await coll.replaceOne(
      { _id: id } as never,
      { _id: id, ...(rest as Omit<T, "id">) } as never,
      { upsert: true }
    );
    return record;
  }

  async remove(id: string): Promise<boolean> {
    const coll = await this.coll();
    const res = await coll.deleteOne({ _id: id } as never);
    return res.deletedCount > 0;
  }
}

/**
 * STORE SEAM: the one factory that selects the active store. With `MONGODB_URI`
 * configured every collection is a `MongoCollection`; otherwise the JSON-on-
 * volume `JsonCollection` is used (the default/fallback so the demo and tests
 * run with no database). No caller is aware of which store is returned.
 */
function collection<T extends { id: string }>(name: CollectionName): Collection<T> {
  if (mongoConfigured()) {
    return new MongoCollection<T>(name);
  }
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
const authorsStore = collection<Author>("authors");
const coursesStore = collection<Course>("courses");
const playlistsStore = collection<Playlist>("playlists");

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
  difficulty?: Difficulty;
  system?: BodySystem;
  tags?: string[];
  authorId?: string;
  // Exam-grade teaching details (all optional; additive / back-compat).
  clinicalHistory?: string;
  patientAge?: string;
  patientSex?: PatientSex;
  technique?: string;
  primaryDiagnosis?: string;
  differentials?: string[];
  targetLevel?: TargetLevel;
  learningObjectives?: string[];
  discussion?: string;
  references?: string[];
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
    difficulty: input.difficulty,
    system: input.system,
    tags: input.tags,
    authorId: input.authorId,
    // Exam-grade teaching details.
    clinicalHistory: input.clinicalHistory,
    patientAge: input.patientAge,
    patientSex: input.patientSex,
    technique: input.technique,
    primaryDiagnosis: input.primaryDiagnosis,
    differentials: input.differentials,
    targetLevel: input.targetLevel,
    learningObjectives: input.learningObjectives,
    discussion: input.discussion,
    references: input.references,
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
    | "title"
    | "modality"
    | "pacsbinBaseUrl"
    | "patientId"
    | "specialty"
    | "status"
    | "studyRefs"
    | "difficulty"
    | "system"
    | "tags"
    | "authorId"
    // Exam-grade teaching details.
    | "clinicalHistory"
    | "patientAge"
    | "patientSex"
    | "technique"
    | "primaryDiagnosis"
    | "differentials"
    | "targetLevel"
    | "learningObjectives"
    | "discussion"
    | "references"
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

// ============================================================================
// Catalog — the filterable case library (CLAUDE.md §2). A single org-scoped
// query that the public /api/catalog route and the catalog pages share.
// ============================================================================

export interface CatalogFilter {
  system?: BodySystem;
  difficulty?: Difficulty;
  modality?: string;
  specialty?: string;
  authorId?: string;
  /** Free-text search over title / tags / specialty. */
  q?: string;
  /** Filter by publication status (defaults to all when omitted). */
  status?: CaseStatus;
  /** Sort key. Defaults to most-recently-updated. */
  sort?: "recent" | "title" | "difficulty";
}

const DIFFICULTY_RANK: Record<Difficulty, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

/**
 * List an org's cases matching a set of catalog filters. All filters are AND-ed;
 * omitted filters don't constrain. Back-compatible: cases without the new
 * taxonomy fields simply don't match `system`/`difficulty`/`author` filters but
 * always appear in the unfiltered catalog.
 */
export async function listCatalogCases(
  orgId: string,
  filter: CatalogFilter = {}
): Promise<Case[]> {
  const all = (await casesStore.all()).map(normalizeCase).filter((c) => c.orgId === orgId);
  const q = filter.q?.trim().toLowerCase();

  const matched = all.filter((c) => {
    if (filter.status && c.status !== filter.status) return false;
    if (filter.system && c.system !== filter.system) return false;
    if (filter.difficulty && c.difficulty !== filter.difficulty) return false;
    if (filter.modality && c.modality !== filter.modality) return false;
    if (filter.specialty && c.specialty !== filter.specialty) return false;
    if (filter.authorId && c.authorId !== filter.authorId) return false;
    if (q) {
      const haystack = [
        c.title,
        c.specialty ?? "",
        c.modality,
        c.system ?? "",
        ...(c.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const sort = filter.sort ?? "recent";
  return matched.sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "difficulty") {
      const ra = a.difficulty ? DIFFICULTY_RANK[a.difficulty] : 99;
      const rb = b.difficulty ? DIFFICULTY_RANK[b.difficulty] : 99;
      if (ra !== rb) return ra - rb;
      return a.title.localeCompare(b.title);
    }
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

/** Distinct facet values present in an org's cases — to populate filter UIs. */
export interface CatalogFacets {
  systems: BodySystem[];
  difficulties: Difficulty[];
  modalities: string[];
  specialties: string[];
}

export async function getCatalogFacets(orgId: string): Promise<CatalogFacets> {
  const all = (await casesStore.all()).map(normalizeCase).filter((c) => c.orgId === orgId);
  const systems = new Set<BodySystem>();
  const difficulties = new Set<Difficulty>();
  const modalities = new Set<string>();
  const specialties = new Set<string>();
  for (const c of all) {
    if (c.system) systems.add(c.system);
    if (c.difficulty) difficulties.add(c.difficulty);
    if (c.modality) modalities.add(c.modality);
    if (c.specialty) specialties.add(c.specialty);
  }
  return {
    systems: [...systems],
    difficulties: [...difficulties],
    modalities: [...modalities].sort(),
    specialties: [...specialties].sort(),
  };
}

// ============================================================================
// orgId-scoped Author API
// ============================================================================

export async function listAuthors(orgId: string): Promise<Author[]> {
  const all = await authorsStore.all();
  return all.filter((a) => a.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAuthor(orgId: string, authorId: string): Promise<Author | null> {
  const a = await authorsStore.get(authorId);
  return a && a.orgId === orgId ? a : null;
}

export interface CreateAuthorInput {
  id?: string;
  name: string;
  avatarUrl?: string;
  bio?: string;
  institution?: string;
}

export async function createAuthor(orgId: string, input: CreateAuthorInput): Promise<Author> {
  const now = nowIso();
  const author: Author = {
    id: input.id ? safeId(input.id) : genId("auth"),
    orgId,
    name: input.name,
    avatarUrl: input.avatarUrl,
    bio: input.bio,
    institution: input.institution,
    createdAt: now,
    updatedAt: now,
  };
  await authorsStore.put(author);
  return author;
}

export async function updateAuthor(
  orgId: string,
  authorId: string,
  patch: Partial<Pick<Author, "name" | "avatarUrl" | "bio" | "institution">>
): Promise<Author | null> {
  const current = await getAuthor(orgId, authorId);
  if (!current) return null;
  const updated: Author = { ...current, ...patch, id: authorId, orgId, updatedAt: nowIso() };
  await authorsStore.put(updated);
  return updated;
}

export async function deleteAuthor(orgId: string, authorId: string): Promise<boolean> {
  const current = await getAuthor(orgId, authorId);
  if (!current) return false;
  return authorsStore.remove(authorId);
}

// ============================================================================
// orgId-scoped Course API
// ============================================================================

export async function listCourses(orgId: string, opts: { status?: CaseStatus } = {}): Promise<Course[]> {
  const all = await coursesStore.all();
  return all
    .filter((c) => c.orgId === orgId)
    .filter((c) => (opts.status ? c.status === opts.status : true))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function getCourse(orgId: string, courseId: string): Promise<Course | null> {
  const c = await coursesStore.get(courseId);
  return c && c.orgId === orgId ? c : null;
}

export interface CreateCourseInput {
  id?: string;
  title: string;
  description?: string;
  difficulty?: Difficulty;
  system?: BodySystem;
  authorId?: string;
  caseIds?: string[];
  status?: CaseStatus;
}

export async function createCourse(orgId: string, input: CreateCourseInput): Promise<Course> {
  const now = nowIso();
  const course: Course = {
    id: input.id ? safeId(input.id) : genId("course"),
    orgId,
    title: input.title,
    description: input.description,
    difficulty: input.difficulty,
    system: input.system,
    authorId: input.authorId,
    caseIds: input.caseIds ?? [],
    status: input.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
  await coursesStore.put(course);
  return course;
}

export async function updateCourse(
  orgId: string,
  courseId: string,
  patch: Partial<
    Pick<Course, "title" | "description" | "difficulty" | "system" | "authorId" | "caseIds" | "status">
  >
): Promise<Course | null> {
  const current = await getCourse(orgId, courseId);
  if (!current) return null;
  const updated: Course = { ...current, ...patch, id: courseId, orgId, updatedAt: nowIso() };
  await coursesStore.put(updated);
  return updated;
}

export async function deleteCourse(orgId: string, courseId: string): Promise<boolean> {
  const current = await getCourse(orgId, courseId);
  if (!current) return false;
  return coursesStore.remove(courseId);
}

// ============================================================================
// orgId-scoped Playlist API
// ============================================================================

export async function listPlaylists(orgId: string): Promise<Playlist[]> {
  const all = await playlistsStore.all();
  return all
    .filter((p) => p.orgId === orgId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function getPlaylist(orgId: string, playlistId: string): Promise<Playlist | null> {
  const p = await playlistsStore.get(playlistId);
  return p && p.orgId === orgId ? p : null;
}

export interface CreatePlaylistInput {
  id?: string;
  title: string;
  description?: string;
  caseIds?: string[];
}

export async function createPlaylist(orgId: string, input: CreatePlaylistInput): Promise<Playlist> {
  const now = nowIso();
  const playlist: Playlist = {
    id: input.id ? safeId(input.id) : genId("pl"),
    orgId,
    title: input.title,
    description: input.description,
    caseIds: input.caseIds ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await playlistsStore.put(playlist);
  return playlist;
}

export async function updatePlaylist(
  orgId: string,
  playlistId: string,
  patch: Partial<Pick<Playlist, "title" | "description" | "caseIds">>
): Promise<Playlist | null> {
  const current = await getPlaylist(orgId, playlistId);
  if (!current) return null;
  const updated: Playlist = { ...current, ...patch, id: playlistId, orgId, updatedAt: nowIso() };
  await playlistsStore.put(updated);
  return updated;
}

export async function deletePlaylist(orgId: string, playlistId: string): Promise<boolean> {
  const current = await getPlaylist(orgId, playlistId);
  if (!current) return false;
  return playlistsStore.remove(playlistId);
}

/**
 * Resolve an ordered list of case IDs into full cases, preserving order and
 * dropping any that no longer exist (or belong to another org). Shared by the
 * course/playlist pages so a curated rail never renders dangling references.
 */
export async function getCasesByIds(orgId: string, caseIds: string[]): Promise<Case[]> {
  const resolved = await Promise.all(caseIds.map((id) => getCaseForOrg(orgId, id)));
  return resolved.filter((c): c is Case => c != null);
}
