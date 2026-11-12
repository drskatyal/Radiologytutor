import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { JournalRecorder, recoverCapture } from "./recorder";
import type { CaptureLocalStore, LocalCapture, LocalChunk } from "./localStore";
import type { CaptureRemote } from "./sync";
import { assertComplete, newManifest } from "./manifest";
import { trackFromJournal } from "./track";
import type { CaptureManifest, JournalEntry, RenderedView } from "./types";
import type { RenderConfirmedViewer } from "../viewerController";
import { journalTestView } from "./fixtures";

class MemoryStore implements CaptureLocalStore {
  sessions = new Map<string, LocalCapture>();
  retained = new Map<string, LocalChunk>();
  writes: string[] = [];
  async save(local: LocalCapture) { this.sessions.set(local.manifest.sessionId, structuredClone(local)); }
  async put(local: LocalCapture, chunk: LocalChunk) { await this.save(local); this.retained.set(chunk.key, structuredClone(chunk)); this.writes.push(chunk.key); }
  async get(id: string) { return structuredClone(this.sessions.get(id)); }
  async list(orgId: string, caseId: string) { return [...this.sessions.values()].filter(c => c.orgId === orgId && c.manifest.caseId === caseId).map(c => structuredClone(c)); }
  async chunks(id: string) { return [...this.retained.values()].filter(c => c.sessionId === id).sort((a, b) => a.chunk.seq - b.chunk.seq).map(c => structuredClone(c)); }
  async ack(chunk: LocalChunk) { this.retained.set(chunk.key, structuredClone({ ...chunk, acked: true })); }
}
class Remote implements CaptureRemote {
  manifests = new Map<string, CaptureManifest>();
  sent: number[] = [];
  loseResponse = false;
  constructor(private store: MemoryStore) {}
  async manifest(local: LocalCapture) {
    const id = local.manifest.sessionId;
    if (!this.manifests.has(id)) this.manifests.set(id, newManifest(local.manifest.caseId, id));
    return structuredClone(this.manifests.get(id)!);
  }
  async put(local: LocalCapture, chunk: LocalChunk) {
    assert.ok(this.store.retained.has(chunk.key), "local transaction must commit before upload");
    this.manifests.get(local.manifest.sessionId)!.chunks.push(chunk.chunk);
    this.sent.push(chunk.chunk.seq);
    if (this.loseResponse) { this.loseResponse = false; throw new Error("Synthetic lost response"); }
  }
  async complete(local: LocalCapture) {
    const journal = await entries(this.store, local.manifest.sessionId);
    assertComplete(this.manifests.get(local.manifest.sessionId)!, local.manifest, journal);
    const manifest = { ...local.manifest, status: "complete" as const };
    this.manifests.set(manifest.sessionId, manifest);
    return { id: manifest.sessionId, manifest, track: trackFromJournal(journal, manifest), journal, durationMs: manifest.durationMs, createdAt: manifest.createdAt };
  }
}
async function entries(store: MemoryStore, id: string): Promise<JournalEntry[]> {
  const result: JournalEntry[] = [];
  for (const chunk of await store.chunks(id)) if (chunk.chunk.stream === "journal") result.push(...JSON.parse(await chunk.blob.text()));
  return result;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function browser(t: TestContext) {
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  const stopped: number[] = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push(clock) }], getVideoTracks: () => [{}] } as unknown as MediaStream;
  class FakeMediaRecorder {
    static all: FakeMediaRecorder[] = [];
    static isTypeSupported() { return true; }
    mimeType: string; timeslice = 0; state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void; onstart?: () => void; onstop?: () => void; onpause?: () => void; onresume?: () => void;
    constructor(_stream: MediaStream, opts: { mimeType: string }) { this.mimeType = opts.mimeType; FakeMediaRecorder.all.push(this); }
    start(timeslice: number) { this.timeslice = timeslice; this.state = "recording"; queueMicrotask(() => this.onstart?.()); }
    data() { this.ondataavailable?.({ data: new Blob(["synthetic media"], { type: this.mimeType }) }); }
    stop() { this.data(); this.state = "inactive"; queueMicrotask(() => this.onstop?.()); }
  }
  class FakeFileReader {
    result = ""; onloadend?: () => void;
    async readAsDataURL(blob: Blob) { this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`; this.onloadend?.(); }
  }
  const document = Object.assign(new EventTarget(), { hidden: false });
  let getUserMedia = async () => stream;
  for (const [name, value] of Object.entries({ document, MediaRecorder: FakeMediaRecorder, FileReader: FakeFileReader, navigator: { mediaDevices: { getUserMedia: () => getUserMedia() } } })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  }
  let listener: ((view: RenderedView) => void) | undefined;
  const viewer: RenderConfirmedViewer = {
    onRendered: cb => { listener = cb; return () => { listener = undefined; }; },
    getRenderedView: () => ({ snapshot: journalTestView, at: clock }),
    requestView: async cmd => ({ snapshot: cmd.snapshot, at: clock, commandId: cmd.commandId, generation: cmd.generation }),
    captureImagePoint: () => ({ snapshot: journalTestView, imagePoint: { x: 23, y: 42 }, dimensions: [64, 64] }),
  };
  return { stream, stopped, media: FakeMediaRecorder.all, viewer,
    visibility: (hidden: boolean) => { document.hidden = hidden; document.dispatchEvent(new Event("visibilitychange")); },
    clock: (value: number) => { clock = value; },
    mic: (fn: () => Promise<MediaStream>) => { getUserMedia = fn; },
    render: (seq = 1) => listener?.({ at: clock, snapshot: { ...journalTestView, renderSeq: seq } }),
  };
}

test("P0-3/T5/T6 delayed mic stays starting; render time, first media offsets, geometry and delivery gap share one clock", async t => {
  const b = browser(t); const store = new MemoryStore(); const remote = new Remote(store);
  let permit!: (stream: MediaStream) => void;
  b.mic(() => new Promise(resolve => { permit = resolve; }));
  const phases: string[] = [];
  const recorder = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote, id: "take-delayed", onPhase: p => phases.push(p) });
  await recorder.start({ sliceIndex: 2 }, { videoStream: b.stream });
  assert.deepEqual(phases, ["starting"]);
  b.clock(1100); recorder.handle.onEvent({ type: "slice", index: 1 });
  b.clock(1400); b.render(); recorder.marker(.4, .5);
  b.clock(1800); permit(b.stream); await tick();
  assert.deepEqual(phases, ["starting"], "opening a stream is not a first sample");
  b.clock(3800); b.media.find(m => m.mimeType.startsWith("audio"))!.data();
  assert.deepEqual(phases, ["starting", "recording"]);
  assert.ok(b.media.every(m => m.timeslice === 2000));
  b.clock(6800); b.media[0].data(); b.media[1].onpause?.(); b.media[1].onresume?.(); b.visibility(true);
  const stopped = await recorder.stop();
  assert.equal(stopped.track.audioOffsetMs, 800);
  assert.equal(stopped.track.videoOffsetMs, 0);
  const journal = await entries(store, recorder.id);
  assert.equal(journal.find(e => e.kind === "input")!.t, 100);
  assert.equal(journal.find(e => e.kind === "render")!.t, 400);
  assert.equal(journal.find(e => e.kind === "render")!.snapshot!.sopUID, journalTestView.sopUID);
  assert.deepEqual(journal.find(e => e.kind === "marker")!.payload!.imagePoint, { x: 23, y: 42 });
  for (const reason of ["permission_delay", "media_delivery_gap", "media_pause", "media_resume", "visibility_change"]) assert.ok(journal.some(e => e.payload?.reason === reason), reason);
  assert.ok((await store.get(recorder.id))!.synced);
  assert.equal(new Set(remote.sent).size, remote.sent.length);
});

test("T5 denied microphone has a clean error, releases resources, and a second start uses a new session clock", async t => {
  const b = browser(t); const store = new MemoryStore(); const remote = new Remote(store); const errors: string[] = [];
  b.mic(async () => { throw new Error("permission denied"); });
  const first = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote, onError: e => errors.push(e) });
  await first.start({ sliceIndex: 0 }); b.clock(1100); b.render();
  const silent = await first.stop();
  assert.equal(silent.audio, null); assert.match(errors[0], /Microphone unavailable/);
  b.clock(5000); b.mic(async () => b.stream);
  const second = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote });
  await second.start({ sliceIndex: 0 }); b.clock(5100); b.render();
  b.clock(7100); b.media[0].data(); const voiced = await second.stop();
  assert.notEqual(first.id, second.id);
  assert.equal(voiced.track.audioOffsetMs, 0);
  assert.equal(voiced.track.journal!.find(e => e.kind === "render")!.t, 100);
  assert.ok(voiced.audio); assert.ok(b.stopped.length > 0);
});

test("T4 recovery reconciles a lost acknowledgement, uploads only missing chunks, and preserves every journal entry", async t => {
  const b = browser(t); const store = new MemoryStore(); const remote = new Remote(store);
  const recorder = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote });
  await recorder.start({ sliceIndex: 0 }); b.clock(1200); b.render(); b.clock(3200); b.media[0].data();
  remote.loseResponse = true;
  await recorder.stop();
  const before = (await store.get(recorder.id))!;
  assert.equal(before.synced, false); assert.equal(remote.sent.length, 1);
  const original = await entries(store, recorder.id);
  // A crashed page had not closed its local manifest.
  before.closed = false; await store.save(before);
  const recovered = await recoverCapture(before, store, remote);
  assert.equal(recovered.synced, true);
  assert.deepEqual((await entries(store, recorder.id)).slice(0, original.length), original);
  assert.equal((await entries(store, recorder.id)).at(-1)!.payload!.reason, "page_interrupted");
  assert.equal(new Set(remote.sent).size, remote.sent.length, "acknowledged chunk was not sent twice");
  const sent = remote.sent.length;
  await recoverCapture(recovered, store, remote); assert.equal(remote.sent.length, sent);
});

test("storage failure is visible and never uploaded or reported as a durable take", async t => {
  const b = browser(t); const store = new MemoryStore(); const remote = new Remote(store);
  t.mock.method(store, "put", async () => { throw new Error("quota"); });
  const errors: string[] = [];
  const recorder = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote, onError: e => errors.push(e) });
  await recorder.start({ sliceIndex: 0 }); b.render();
  await assert.rejects(recorder.stop(), /quota/);
  assert.equal(remote.sent.length, 0); assert.ok(errors.some(e => /browser storage/.test(e)));
});

test("stopping is idempotent and a permission rejection after stop cannot revive capture", async t => {
  const b = browser(t); const store = new MemoryStore(); const remote = new Remote(store);
  let deny!: (error: Error) => void;
  b.mic(() => new Promise((_resolve, reject) => { deny = reject; }));
  const phases: string[] = [];
  const recorder = new JournalRecorder({ caseId: "synthetic", orgId: "org", viewer: b.viewer, store, remote, onPhase: phase => phases.push(phase) });
  await recorder.start({ sliceIndex: 0 }); b.clock(1100); b.render();
  const stop = recorder.stop(); assert.equal(recorder.stop(), stop);
  await stop;
  const completed = [...phases];
  deny(new Error("Synthetic late denial")); await tick();
  assert.deepEqual(phases, completed);
  assert.equal(phases.at(-1), "stopped"); assert.equal(recorder.isRecording, false);
});
