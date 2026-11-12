import { TrackRecorder, type RecorderHandle, type RecorderHooks, type RecorderResult } from "../recorder";
import type { RecordedTrack, ViewerEvent } from "../types";
import type { RenderConfirmedViewer } from "../viewerController";
import type { CaptureStream, JournalEntry, RenderedView } from "./types";
import { newManifest } from "./manifest";
import { captureLocalStore, type CaptureLocalStore, type LocalCapture, type LocalChunk } from "./localStore";
import { captureRemote, syncCapture, type CaptureRemote } from "./sync";
import { trackFromJournal } from "./track";

export type CapturePhase = "starting" | "recording" | "stopped";
export interface JournalRecorderOptions {
  caseId: string; orgId: string; viewer: RenderConfirmedViewer;
  store?: CaptureLocalStore; remote?: CaptureRemote; now?: () => number; id?: string;
  recorder?: TrackRecorder;
  onPhase?: (phase: CapturePhase) => void;
  onError?: (message: string) => void;
  onSync?: (acked: number) => void;
}

export async function chunkDigest(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/** Durable wrapper. Input is intent; only onRendered supplies authoritative image state. */
export class JournalRecorder {
  readonly id: string;
  private readonly base: TrackRecorder;
  private readonly store: CaptureLocalStore;
  private readonly remote: CaptureRemote;
  private readonly now: () => number;
  private local: LocalCapture;
  private journal: JournalEntry[] = [];
  private t0 = 0;
  private active = false;
  private stopping: Promise<RecorderResult> | null = null;
  private firstAudio = false;
  private lastCursor = -Infinity;
  private pending: Promise<void> = Promise.resolve();
  private storageError: unknown;
  private uploading: Promise<void> | null = null;
  private offRender: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private visibility = () => this.entry("discontinuity", { reason: "visibility_change", hidden: document.hidden });

  constructor(private options: JournalRecorderOptions) {
    this.id = options.id ?? crypto.randomUUID(); // allocated before permission or capture
    this.base = options.recorder ?? new TrackRecorder();
    this.store = options.store ?? captureLocalStore;
    this.remote = options.remote ?? captureRemote;
    this.now = options.now ?? (() => performance.now());
    this.local = { orgId: options.orgId, manifest: newManifest(options.caseId, this.id), closed: false, synced: false };
  }
  get isRecording(): boolean { return this.active && !this.stopping; }
  elapsedMs(): number { return Math.max(0, this.now() - this.t0); }
  readonly handle: RecorderHandle = {
    onEvent: (event: ViewerEvent) => {
      if (!this.active) return;
      this.base.handle.onEvent(event);
      this.entry("input", { event });
      if (event.type === "annotation") {
        const snapshot = this.options.viewer.getRenderedView()?.snapshot;
        this.entry("annotation", { event, geometryStatus: "unresolved" }, snapshot);
        if (["Length", "Angle", "EllipticalROI", "Probe"].includes(event.tool ?? "")) this.entry("measurement", { event, calibrationStatus: "unresolved" }, snapshot);
      }
    },
    pushCursor: (x, y) => {
      if (!this.active) return;
      this.base.handle.pushCursor(x, y);
      if (this.now() - this.lastCursor >= 40) {
        this.lastCursor = this.now();
        this.entry("input", { event: { type: "cursor", x, y } });
      }
    },
  };
  marker(x: number, y: number): void {
    if (!this.active) return;
    const point = this.options.viewer.captureImagePoint(x, y);
    if (!point) { this.entry("discontinuity", { reason: "marker_without_rendered_image" }); return; }
    this.entry("marker", { markerId: crypto.randomUUID(), imagePoint: point.imagePoint, dimensions: point.dimensions }, point.snapshot);
  }
  private entry(kind: JournalEntry["kind"], payload?: Record<string, unknown>, snapshot?: JournalEntry["snapshot"], at = this.now()): void {
    if (!this.active) return;
    const t = Math.max(0, at - this.t0);
    const entry: JournalEntry = { seq: this.journal.length, t, kind, ...(payload ? { payload } : {}), ...(snapshot ? { snapshot: structuredClone(snapshot), renderSeq: snapshot.renderSeq } : {}) };
    this.journal.push(entry);
    this.enqueue("journal", new Blob([JSON.stringify([entry])], { type: "application/json" }), t, t);
  }
  private rendered = (view: RenderedView) => {
    if (view.at < this.t0) return;
    const previous = [...this.journal].reverse().find(e => e.kind === "render")?.snapshot;
    if (previous && previous.layout !== view.snapshot.layout) this.entry("layout", { previous: previous.layout, current: view.snapshot.layout }, view.snapshot, view.at);
    this.entry("render", view.displayIndex === undefined ? undefined : { displayIndex: view.displayIndex }, view.snapshot, view.at);
  };
  private enqueue(stream: CaptureStream, blob: Blob, tStart: number, tEnd: number): void {
    this.pending = this.pending.then(async () => {
      if (this.storageError) return;
      const chunk = { seq: this.local.manifest.chunks.length, stream, tStart, tEnd, sha256: await chunkDigest(blob), bytes: blob.size, mime: blob.type };
      const retained: LocalChunk = { key: `${this.id}:${chunk.seq}`, sessionId: this.id, chunk, blob, acked: false };
      const next = structuredClone(this.local);
      next.manifest.chunks.push(chunk);
      next.manifest.durationMs = Math.max(next.manifest.durationMs, tEnd);
      if (stream !== "journal" && next.manifest.offsets[stream] === undefined) next.manifest.offsets[stream] = tStart;
      // Transaction completion precedes upload. Failure preserves the previous manifest.
      await this.store.put(next, retained);
      this.local = next;
    }).catch(error => {
      this.storageError = error;
      this.options.onError?.("Capture could not be retained in browser storage. Stop and retry after freeing storage.");
    });
  }
  async start(priming: RecordedTrack["start"], hooks: RecorderHooks = {}): Promise<void> {
    this.t0 = this.now();
    await this.store.save(this.local);
    this.active = true;
    this.options.onPhase?.("starting");
    this.offRender = this.options.viewer.onRendered(this.rendered);
    this.entry("discontinuity", { reason: "permission_pending" });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.visibility);
    const current = this.options.viewer.getRenderedView();
    if (current) void this.options.viewer.requestView({ commandId: `capture-${this.id}`, generation: 0, snapshot: current.snapshot }).catch(() => this.options.onError?.("Capture is waiting for a confirmed image render."));
    await this.base.start(priming, {
      ...hooks, t0: this.t0, timesliceMs: 2000,
      onMic: state => {
        if (!this.active) return;
        hooks.onMic?.(state);
        if (state === "unavailable") {
          this.entry("discontinuity", { reason: "microphone_unavailable" });
          this.options.onError?.("Microphone unavailable. Allow microphone access, stop this take, then start again. Viewer events remain retained.");
          this.options.onPhase?.("recording"); // explicit silent capture, never falsely a pending live microphone
        }
      },
      onMediaStart: (stream, offset) => this.entry("discontinuity", { reason: stream === "audio" ? "permission_delay" : "media_start", stream, offsetMs: offset, timingSource: "MediaRecorder.start event", estimated: true }),
      onDiscontinuity: (reason, details) => this.entry("discontinuity", { reason, ...details }),
      onChunk: (stream, blob, start, end) => {
        if (stream === "audio" && !this.firstAudio) { this.firstAudio = true; this.options.onPhase?.("recording"); }
        this.enqueue(stream, blob, start, end);
      },
    });
    this.timer = setInterval(() => { void this.sync(); }, 2000);
  }
  private async sync(): Promise<void> {
    if (this.uploading || this.storageError) return this.uploading ?? undefined;
    this.uploading = (async () => {
      await this.pending;
      const retained = await this.store.get(this.id);
      if (!retained) return;
      await syncCapture(retained, this.store, this.remote);
      this.options.onSync?.(retained.manifest.chunks.length);
    })().catch(() => this.options.onError?.("Capture is retained in this browser. Server sync failed; use Retry sync when connected.")).finally(() => { this.uploading = null; });
    return this.uploading;
  }
  stop(): Promise<RecorderResult> {
    this.stopping ??= this.finish();
    return this.stopping;
  }
  private async finish(): Promise<RecorderResult> {
    if (this.timer) clearInterval(this.timer);
    const result = await this.base.stop(); // flush final media while the journal is still listening
    this.entry("discontinuity", { reason: "capture_stopped" });
    this.active = false;
    this.offRender?.(); this.offRender = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibility);
    await this.pending;
    if (this.storageError) throw this.storageError;
    this.local.closed = true;
    this.local.manifest.durationMs = Math.max(this.local.manifest.durationMs, this.elapsedMs());
    this.local.track = { ...result.track, ...trackFromJournal(this.journal, this.local.manifest), events: result.track.events };
    await this.store.save(this.local);
    await this.uploading;
    await this.sync();
    this.local = await this.store.get(this.id) ?? this.local;
    this.options.onPhase?.("stopped");
    return { ...result, track: this.local.track ?? trackFromJournal(this.journal, this.local.manifest), micOffsetMs: this.local.manifest.offsets.audio ?? 0 };
  }
}

/** Recover retained bytes, not an invented continuation of a clock that died with the tab. */
export async function recoverCapture(local: LocalCapture, store: CaptureLocalStore = captureLocalStore, remote: CaptureRemote = captureRemote): Promise<LocalCapture> {
  const chunks = await store.chunks(local.manifest.sessionId);
  const journal: JournalEntry[] = [];
  for (const retained of chunks) {
    if (await chunkDigest(retained.blob) !== retained.chunk.sha256) throw new Error("Local capture checksum failed; no retained data was removed.");
    if (retained.chunk.stream === "journal") journal.push(...JSON.parse(await retained.blob.text()));
  }
  if (!local.closed) {
    local.manifest.status = "interrupted";
    const entry: JournalEntry = { seq: journal.length, t: local.manifest.durationMs, kind: "discontinuity", payload: { reason: "page_interrupted", unretainedTail: "unknown", estimated: true } };
    journal.push(entry);
    const blob = new Blob([JSON.stringify([entry])], { type: "application/json" });
    const chunk = { seq: chunks.length, stream: "journal" as const, tStart: entry.t, tEnd: entry.t, sha256: await chunkDigest(blob), bytes: blob.size, mime: blob.type };
    local.manifest.chunks.push(chunk); local.closed = true;
    await store.put(local, { key: `${local.manifest.sessionId}:${chunk.seq}`, sessionId: local.manifest.sessionId, chunk, blob, acked: false });
  }
  local.track = trackFromJournal(journal, local.manifest);
  await store.save(local);
  await syncCapture(local, store, remote);
  return local;
}
