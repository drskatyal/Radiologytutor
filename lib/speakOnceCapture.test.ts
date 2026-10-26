import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { displaySliceNumber } from "./findingDisplayState.ts";
import { mergeCaptureDemonstration } from "./harness/mergeCapture.ts";
import { TrackRecorder } from "./recorder.ts";
import {
  authoredGuideLines,
  commitSpeakOnceWithoutMic,
  formatRecordedSave,
  resolveTeachingGuide,
  TEACH_ACTS,
} from "./teachingGuide.ts";
import type { RecordedTrack, ViewerEvent } from "./types.ts";

/**
 * Speak-once on a machine with no microphone. getUserMedia must not be
 * required for the viewer track to start, and a denied or hung mic must
 * still return the scroll / window / zoom / point log.
 */

class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:audio/webm;base64,${Buffer.from(buf).toString("base64")}`;
      this.onloadend?.();
    });
  }
}

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType || "audio/webm";
  }
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function installMedia(getUserMedia: () => Promise<MediaStream>) {
  const nav = globalThis.navigator as Navigator & { mediaDevices?: MediaDevices };
  const prevDevices = nav.mediaDevices;
  const prevRecorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const prevReader = (globalThis as { FileReader?: typeof FileReader }).FileReader;
  nav.mediaDevices = { getUserMedia } as unknown as MediaDevices;
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as { FileReader?: unknown }).FileReader = FakeFileReader;
  return () => {
    nav.mediaDevices = prevDevices;
    if (prevRecorder) (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder = prevRecorder;
    else delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    if (prevReader) (globalThis as { FileReader?: typeof FileReader }).FileReader = prevReader;
    else delete (globalThis as { FileReader?: unknown }).FileReader;
  };
}

function pushViewer(rec: TrackRecorder) {
  const events: ViewerEvent[] = [
    { type: "slice", index: 4 },
    { type: "voi", ww: 1500, wc: -600 },
    { type: "camera", zoom: 2.4, pan: [0, 0] },
    { type: "slice", index: 21 },
  ];
  for (const event of events) rec.handle.onEvent(event);
  rec.handle.pushCursor(0.33, 0.66);
}

function assertViewerTrack(track: RecordedTrack) {
  const types = track.events.map((event) => event.type);
  assert.ok(types.includes("slice"));
  assert.ok(types.includes("voi"));
  assert.ok(types.includes("camera"));
  assert.ok(types.includes("cursor"));
  const slice = [...track.events].reverse().find((event) => event.type === "slice");
  assert.equal(slice && slice.type === "slice" ? slice.index : null, 21);
  const voi = [...track.events].reverse().find((event) => event.type === "voi");
  assert.equal(voi && voi.type === "voi" ? voi.ww : null, 1500);
  const camera = [...track.events].reverse().find((event) => event.type === "camera");
  assert.equal(camera && camera.type === "camera" ? camera.zoom : null, 2.4);
  const cursor = [...track.events].reverse().find((event) => event.type === "cursor");
  assert.equal(cursor && cursor.type === "cursor" ? cursor.x : null, 0.33);
  assert.equal(cursor && cursor.type === "cursor" ? cursor.y : null, 0.66);
}

async function settleStart(rec: TrackRecorder): Promise<"started" | "hung"> {
  return Promise.race([
    rec.start({ sliceIndex: 2, ww: 400, wc: 40 }).then(() => "started" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 80)),
  ]);
}

test("start records the viewer track when getUserMedia never resolves", async () => {
  const restore = installMedia(() => new Promise<MediaStream>(() => {}));
  try {
    const rec = new TrackRecorder();
    assert.equal(await settleStart(rec), "started");
    assert.equal(rec.isRecording, true);
    pushViewer(rec);
    const stopped = await Promise.race([
      rec.stop(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    assert.ok(stopped, "stop hung waiting for the microphone");
    assert.equal(stopped.audio, null);
    assertViewerTrack(stopped.track);
    assert.equal(stopped.track.voice, undefined);
  } finally {
    restore();
  }
});

test("a denied microphone still returns the viewer track and no audio", async () => {
  const restore = installMedia(async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  });
  try {
    const rec = new TrackRecorder();
    assert.equal(await settleStart(rec), "started");
    assert.equal(rec.isRecording, true);
    pushViewer(rec);
    const stopped = await rec.stop();
    assert.equal(stopped.audio, null);
    assertViewerTrack(stopped.track);
  } finally {
    restore();
  }
});

test("speak-once without a microphone saves a notes guide from the viewer track", async () => {
  const restore = installMedia(() => new Promise<MediaStream>(() => {}));
  try {
    const rec = new TrackRecorder();
    assert.equal(await settleStart(rec), "started");
    pushViewer(rec);
    const stopped = await Promise.race([
      rec.stop(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    assert.ok(stopped);
    assert.equal(stopped.audio, null);
    assert.equal(stopped.track.voice, undefined);

    const label = "Right upper lobe nodule";
    const description = "Solid nodule in the right upper lobe.";
    const teachingPoints = ["Compare it with the vessel."];
    const saved = commitSpeakOnceWithoutMic(
      {
        label,
        description,
        teachingPoints,
        marker: { x_pct: 0.33, y_pct: 0.66, shape: "circle" },
        teachingGuide: {
          durationMs: 10,
          start: { sliceIndex: 0 },
          beats: [{ t: 0, act: "pearl", actions: [], say: "Demo pearl must not play." }],
        },
      },
      stopped.track
    );

    assert.equal(stopped.track.voice, undefined);
    assert.equal(saved.finding.track?.voice, "notes");
    assert.notEqual(saved.finding.track, stopped.track);
    assert.equal(saved.receipt.gap, "empty-mic");
    assert.equal(saved.receipt.alignment, "prose");
    assert.equal(saved.receipt.demoSuperseded, true);
    assert.deepEqual(saved.receipt.acts, [...TEACH_ACTS]);
    assert.equal(authoredGuideLines(saved.finding.teachingGuide).length, saved.receipt.beatCount);

    const guide = saved.finding.teachingGuide;
    const say = (act: string) => guide?.beats.find((beat) => beat.act === act)?.say ?? "";
    assert.equal(say("orient"), `${label}, on slice ${displaySliceNumber(21)}.`);
    assert.equal(say("search"), "Window 1500 over -600.");
    assert.equal(say("lean-in"), "Closer, about 2.4 times.");
    assert.equal(say("commit"), description);
    assert.equal(say("pearl"), "Compare it with the vessel.");
    assert.doesNotMatch(say("orient"), /Follow the stack/);
    assert.doesNotMatch(lines(guide), /Lung windows|Follow the vessels|Look here|must not play/);

    const scroll = guide?.beats.find((beat) => beat.act === "orient")?.actions[0];
    assert.equal(scroll?.type, "scroll");
    if (scroll?.type === "scroll") assert.equal(scroll.sliceIndex, 21);
    const zoom = guide?.beats.find((beat) => beat.act === "lean-in")?.actions[0];
    assert.equal(zoom?.type, "zoom");
    if (zoom?.type === "zoom") assert.equal(zoom.zoom, 2.4);
    const point = guide?.beats
      .find((beat) => beat.act === "commit")
      ?.actions.find((action) => action.type === "point");
    assert.equal(point?.type, "point");
    if (point?.type === "point") {
      assert.equal(point.x, 0.33);
      assert.equal(point.y, 0.66);
    }

    const narrated = (saved.finding.track?.narration ?? []).map((span) => span.text).join(" ");
    assert.match(narrated, /right upper lobe/i);
    assert.match(narrated, /vessel/i);

    const message = formatRecordedSave(saved.receipt);
    assert.match(message.description, /5 teach beats/);
    assert.match(message.description, /No microphone/);
    assert.match(message.description, /Demo tour replaced/);

    const poisoned = resolveTeachingGuide({
      ...saved.finding,
      teachingGuide: {
        durationMs: 10,
        start: { sliceIndex: 0 },
        beats: [{ t: 0, act: "pearl", actions: [], say: "Demo pearl must not play." }],
      },
    });
    assert.equal(lines(poisoned), lines(guide));

    const seed = JSON.parse(
      readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
    ) as { findings: Array<{ label: string; track?: unknown; teachingGuide?: { beats: Array<{ say?: string }> } }> };
    const nodule = seed.findings.find((finding) => /nodule/i.test(finding.label));
    assert.ok(nodule?.teachingGuide);
    assert.equal(nodule.track, undefined);
    assert.equal(resolveTeachingGuide(nodule), nodule.teachingGuide);
    assert.match(nodule.teachingGuide.beats.map((beat) => beat.say ?? "").join(" "), /Follow the stack/);
  } finally {
    restore();
  }
});

function lines(guide: { beats: Array<{ say?: string }> } | null | undefined): string {
  return authoredGuideLines(guide).join(" ");
}

test("a transcribed speak-once take keeps the look-cue script", () => {
  const track: RecordedTrack = {
    durationMs: 4000,
    start: { sliceIndex: 2, ww: 400, wc: 40 },
    events: [
      { t: 200, type: "slice", index: 21 },
      { t: 800, type: "voi", ww: 1500, wc: -600 },
      { t: 1400, type: "camera", zoom: 2.4, pan: [0, 0] },
      { t: 2000, type: "cursor", x: 0.33, y: 0.66 },
    ],
  };
  const { findings } = mergeCaptureDemonstration({
    sessionId: "cap_mic",
    parentTrack: track,
    audioUrl: "/api/audio/take",
    transcript: "Solid nodule in the right upper lobe.",
    segments: [
      {
        label: "Right upper lobe nodule",
        description: "Solid nodule in the right upper lobe.",
        teachingPoints: ["Compare it with the vessel."],
        tStartMs: 0,
        tEndMs: 4000,
      },
    ],
  });
  assert.equal(findings[0].track?.voice, undefined);
  const orient = findings[0].teachingGuide?.beats.find((beat) => beat.act === "orient")?.say ?? "";
  assert.match(orient, /^Follow the stack/);
});

test("a live microphone still attaches audio to the viewer track", async () => {
  let release: (stream: MediaStream) => void = () => {};
  const restore = installMedia(
    () =>
      new Promise<MediaStream>((resolve) => {
        release = resolve;
      })
  );
  try {
    const rec = new TrackRecorder();
    assert.equal(await settleStart(rec), "started");
    assert.equal(rec.isRecording, true);
    pushViewer(rec);
    release({ getTracks: () => [{ stop() {} }] } as unknown as MediaStream);
    const stopped = await rec.stop();
    assert.ok(stopped.audio?.base64);
    assert.match(stopped.audio.mimeType, /audio\/webm/);
    assertViewerTrack(stopped.track);
    assert.equal(stopped.track.voice, undefined);
  } finally {
    restore();
  }
});
