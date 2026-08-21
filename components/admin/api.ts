// Thin fetch wrappers around the admin API routes. The client talks only to
// these HTTP endpoints — it never imports the lib/cases data layer (§3).

import {
  OrthancUnavailableError,
  type AdminCaseRow,
  type Author,
  type BodySystem,
  type Case,
  type CaseStatus,
  type CaseStudyRef,
  type Course,
  type Difficulty,
  type Patient,
  type PatientSex,
  type Playlist,
  type SeriesMeta,
  type Study,
  type TargetLevel,
  type UploadResult,
} from "./types";

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchCases(): Promise<AdminCaseRow[]> {
  const res = await fetch("/api/admin/cases", { cache: "no-store" });
  return (await json<{ cases: AdminCaseRow[] }>(res)).cases;
}

export async function fetchPatients(): Promise<Patient[]> {
  const res = await fetch("/api/admin/patients", { cache: "no-store" });
  return (await json<{ patients: Patient[] }>(res)).patients;
}

// ---------------------------------------------------------------------------
// Library: authors
// ---------------------------------------------------------------------------

export async function fetchAuthors(): Promise<Author[]> {
  const res = await fetch("/api/admin/authors", { cache: "no-store" });
  return (await json<{ authors: Author[] }>(res)).authors;
}

export interface AuthorInput {
  name: string;
  bio?: string;
  institution?: string;
  avatarUrl?: string;
}

export async function createAuthor(input: AuthorInput): Promise<Author> {
  const res = await fetch("/api/admin/authors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<{ author: Author }>(res)).author;
}

export async function updateAuthor(
  id: string,
  patch: Partial<AuthorInput> & { verification?: Author["verification"] }
): Promise<Author> {
  const res = await fetch(`/api/admin/authors/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ author: Author }>(res)).author;
}

export async function deleteAuthor(id: string): Promise<void> {
  const res = await fetch(`/api/admin/authors/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

// ---------------------------------------------------------------------------
// Library: courses
// ---------------------------------------------------------------------------

export async function fetchCourses(): Promise<Course[]> {
  const res = await fetch("/api/admin/courses", { cache: "no-store" });
  return (await json<{ courses: Course[] }>(res)).courses;
}

export interface CourseInput {
  title: string;
  description?: string;
  difficulty?: Difficulty;
  system?: BodySystem;
  authorId?: string;
  caseIds?: string[];
  status?: CaseStatus;
}

export async function createCourse(input: CourseInput): Promise<Course> {
  const res = await fetch("/api/admin/courses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<{ course: Course }>(res)).course;
}

export async function updateCourse(
  id: string,
  patch: Partial<CourseInput>
): Promise<Course> {
  const res = await fetch(`/api/admin/courses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ course: Course }>(res)).course;
}

export async function deleteCourse(id: string): Promise<void> {
  const res = await fetch(`/api/admin/courses/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

// ---------------------------------------------------------------------------
// Library: playlists
// ---------------------------------------------------------------------------

export async function fetchPlaylists(): Promise<Playlist[]> {
  const res = await fetch("/api/admin/playlists", { cache: "no-store" });
  return (await json<{ playlists: Playlist[] }>(res)).playlists;
}

export interface PlaylistInput {
  title: string;
  description?: string;
  caseIds?: string[];
}

export async function createPlaylist(input: PlaylistInput): Promise<Playlist> {
  const res = await fetch("/api/admin/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<{ playlist: Playlist }>(res)).playlist;
}

export async function updatePlaylist(
  id: string,
  patch: Partial<PlaylistInput>
): Promise<Playlist> {
  const res = await fetch(`/api/admin/playlists/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ playlist: Playlist }>(res)).playlist;
}

export async function deletePlaylist(id: string): Promise<void> {
  const res = await fetch(`/api/admin/playlists/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

export interface CreateCaseStudyInput {
  studyInstanceUID: string;
  seriesInstanceUIDs?: string[];
  description?: string;
  modality?: string;
  studyDate?: string;
  orthancStudyId?: string;
  caseSeriesInstanceUIDs?: string[];
  role?: CaseStudyRef["role"];
}

/** Exam-grade teaching details shared by create + update inputs. */
export interface CaseDetailsInput {
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

export interface CreateCaseInput extends CaseDetailsInput {
  title: string;
  modality: string;
  specialty?: string;
  status?: CaseStatus;
  patientId?: string;
  patientName?: string;
  studies?: CreateCaseStudyInput[];
  difficulty?: Difficulty;
  system?: BodySystem;
  tags?: string[];
  authorId?: string;
}

export async function createCase(input: CreateCaseInput): Promise<Case> {
  const res = await fetch("/api/admin/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await json<{ case: Case }>(res)).case;
}

export interface UpdateCaseInput extends CaseDetailsInput {
  title?: string;
  modality?: string;
  specialty?: string | null;
  status?: CaseStatus;
  studyRefs?: CaseStudyRef[];
  difficulty?: Difficulty | null;
  system?: BodySystem | null;
  tags?: string[];
  authorId?: string | null;
}

export async function updateCase(
  caseId: string,
  patch: UpdateCaseInput
): Promise<Case> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await json<{ case: Case }>(res)).case;
}

export async function deleteCase(caseId: string): Promise<void> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    method: "DELETE",
  });
  await json<{ ok: true }>(res);
}

export async function fetchCaseDetail(caseId: string): Promise<{
  case: Case;
  patient: Patient | null;
  studies: Study[];
}> {
  const res = await fetch(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
    cache: "no-store",
  });
  return json(res);
}

export async function fetchStudySeries(studyId: string): Promise<{
  study: Study;
  series: SeriesMeta[];
  hasImaging: boolean;
}> {
  const res = await fetch(
    `/api/admin/studies/${encodeURIComponent(studyId)}/series`,
    { cache: "no-store" }
  );
  return json(res);
}

/** Is the DICOM archive wired up at all? Lets the UI degrade gracefully. */
export async function fetchOrthancStatus(): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/orthanc-status", { cache: "no-store" });
    return (await json<{ configured: boolean }>(res)).configured;
  } catch {
    return false;
  }
}

/**
 * Upload one batch of DICOM files to Orthanc, reporting upload progress.
 *
 * Uses XHR (not fetch) because we need real `upload.onprogress` for the
 * progress bar — fetch can't report request-body upload progress in browsers.
 * Throws {@link OrthancUnavailableError} on a 503 so callers can show the calm
 * "imaging not connected" path instead of a scary error.
 */
export function uploadDicomBatch(
  files: File[],
  opts: { onProgress?: (loadedBytes: number, totalBytes: number) => void; signal?: AbortSignal } = {}
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.responseType = "json";

    if (opts.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
      };
    }

    xhr.onload = () => {
      const data = (xhr.response ?? {}) as Partial<UploadResult> & {
        error?: string;
        code?: string;
      };
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({
          stored: data.stored ?? 0,
          series: data.series ?? [],
          failed: data.failed ?? [],
          skipped: data.skipped ?? [],
        });
        return;
      }
      const message = data.error || `Upload failed (${xhr.status}).`;
      if (xhr.status === 503 || data.code === "ORTHANC_NOT_CONFIGURED") {
        reject(new OrthancUnavailableError(message));
      } else {
        reject(new Error(message));
      }
    };
    xhr.onerror = () =>
      reject(new Error("Network error during upload. Check your connection and retry."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Try a smaller batch."));

    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    xhr.send(form);
  });
}
