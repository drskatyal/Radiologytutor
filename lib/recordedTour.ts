/**
 * Record → guide → play.
 *
 * A teacher take (scroll, window, zoom, point, plus a timed transcript)
 * becomes the Teach script. The LIDC demo guide is the fallback only when
 * the finding has no RecordedTrack.
 *
 * Precedence lives in resolveTeachingGuide:
 *   1. RecordedTrack — rebuild. The stored teachingGuide is ignored.
 *   2. Stored teachingGuide — demo, when there is no track.
 *   3. null.
 *
 * Studio save calls withRecordedTeaching after /api/transcribe-narration.
 * This module runs that same alignment (narrationRequestFromBody +
 * publishNarrationTake) on a checked-in WAV and transcript so CI does not
 * need a microphone or a Gemini key. The WAV is the request body. The
 * transcript is the STT stand-in. Learners still hear Gemini TTS, not the file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLidcSeedCase, findingHasTeacherTrack, LIDC_CASE_ID } from "./demoTeachingGuide";
import { withDisplaySnapshot } from "./findingDisplayState";
import {
  guideReplayTutor,
  parseTutorFixture,
  scoreTutorSession,
  silentToolsTutor,
  textOnlyTutor,
  type SessionScore,
  type TutorEvalFixture,
} from "./harness/tutorEval";
import { getPublicCaseTemplate } from "./publicCases/catalog";
import { playTeachingGuide } from "./replay";
import {
  authoredGuideLines,
  narrationRequestFromBody,
  publishNarrationTake,
  resolveTeachingGuide,
  settledDisplay,
  withRecordedTeaching,
} from "./teachingGuide";
import type { Finding, NarrationSpan, RecordedTrack, TeachingGuide } from "./types";

export const RECORDED_TAKE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/recordings"
);

export const LIDC_RECORDED_TAKE_PATH = join(RECORDED_TAKE_DIR, "lidc-finding-1.json");

export interface RecordedTakeFile {
  id: string;
  caseId: string;
  findingOrder: number;
  phi: "none";
  notes?: string;
  audio: { file: string; mime: string };
  transcript: string;
  segments: NarrationSpan[];
  track: RecordedTrack;
}

export interface AppliedRecording {
  /** Demo finding before the take. No track. Its teachingGuide is the fallback. */
  demo: Finding;
  /** Saved finding: track + recorded teachingGuide. */
  finding: Finding;
  /** Alignment the transcribe route would return for this transcript. */
  alignment: "estimated" | "proportional";
  transcript: string;
  /** Request body that passed narrationRequestFromBody. Not sent to Gemini. */
  audioBase64: string;
  mime: string;
}

export interface RecordedTourPlay {
  said: string[];
  log: string[];
  walk: number[];
  landedSlice: number;
}

export interface RecordedTourReport {
  applied: AppliedRecording;
  play: RecordedTourPlay;
  superseded: boolean;
  walked: boolean;
  textOnly: SessionScore;
  silent: SessionScore;
  driver: SessionScore;
  spokenBeat: boolean;
  driveFirst: boolean;
}

export function loadRecordedTake(path = LIDC_RECORDED_TAKE_PATH): RecordedTakeFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RecordedTakeFile;
  if (raw.phi !== "none") throw new Error("Recorded take fixture must declare phi: none.");
  if (!raw.track?.events?.length) throw new Error("Recorded take fixture is missing a track.");
  if (!raw.transcript?.trim()) throw new Error("Recorded take fixture is missing a transcript.");
  if (!raw.audio?.file) throw new Error("Recorded take fixture is missing an audio file.");
  return raw;
}

function readAudioBase64(take: RecordedTakeFile, jsonPath: string): string {
  const file = join(dirname(jsonPath), take.audio.file);
  const bytes = readFileSync(file);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`Recorded take audio is not a WAV: ${take.audio.file}`);
  }
  return bytes.toString("base64");
}

/** LIDC finding that still carries the demo guide (no teacher track). */
export function demoLidcFinding(order = 1): Finding {
  const finding = buildLidcSeedCase().findings.find((item) => item.order === order);
  if (!finding) throw new Error(`LIDC seed has no finding order ${order}.`);
  if (findingHasTeacherTrack(finding)) {
    throw new Error(`LIDC finding ${order} already has a teacher track.`);
  }
  if (!finding.teachingGuide?.beats.length) {
    throw new Error(`LIDC finding ${order} is missing its demo guide.`);
  }
  return finding;
}

/**
 * Save path shared with Studio: validate the audio body, align the transcript
 * the way /api/transcribe-narration does after STT, then withRecordedTeaching.
 * The stored demo guide is replaced. resolveTeachingGuide would rebuild from
 * the track even if that stored guide were put back.
 */
export function applyRecordedTake(
  demo: Finding,
  take: RecordedTakeFile,
  audioBase64: string
): AppliedRecording {
  const money = settledDisplay(take.track);
  if (demo.sliceIndex != null && money.sliceIndex !== demo.sliceIndex) {
    throw new Error(
      `Recorded money slice ${money.sliceIndex} does not match finding slice ${demo.sliceIndex}.`
    );
  }
  const requested = narrationRequestFromBody({
    audio: { base64: audioBase64, mime: take.audio.mime },
    durationMs: take.track.durationMs,
  });
  if (!requested.ok) throw new Error(requested.error);
  const published = publishNarrationTake(
    { transcript: take.transcript, segments: take.segments },
    requested.durationMs
  );
  const taught = withRecordedTeaching(
    demo,
    { ...take.track },
    {
      label: demo.label,
      description: demo.description,
      teachingPoints: demo.teachingPoints,
      spans: published.spans,
    }
  );
  const finding = withDisplaySnapshot(taught, {
    sliceIndex: money.sliceIndex,
    ww: money.ww,
    wc: money.wc,
  });
  return {
    demo,
    finding,
    alignment: published.alignment,
    transcript: published.transcript,
    audioBase64: requested.audioBase64,
    mime: requested.mime,
  };
}

export function loadAppliedLidcRecording(
  path = LIDC_RECORDED_TAKE_PATH
): AppliedRecording {
  const take = loadRecordedTake(path);
  if (take.caseId !== LIDC_CASE_ID) {
    throw new Error(`Recorded take ${take.id} is not ${LIDC_CASE_ID}.`);
  }
  const demo = demoLidcFinding(take.findingOrder);
  return applyRecordedTake(demo, take, readAudioBase64(take, path));
}

/** True when Teach would speak the take, not the demo script. */
export function demoGuideSuperseded(demo: Finding, saved: Finding): boolean {
  if (!findingHasTeacherTrack(saved)) return false;
  if (!saved.track || !saved.teachingGuide?.beats.length) return false;
  const demoLines = authoredGuideLines(demo.teachingGuide).join(" ");
  const storedLines = authoredGuideLines(saved.teachingGuide).join(" ");
  const poisoned: Finding = { ...saved, teachingGuide: demo.teachingGuide };
  const live = resolveTeachingGuide(poisoned);
  const liveLines = authoredGuideLines(live).join(" ");
  if (!demoLines || !storedLines || !liveLines) return false;
  if (storedLines === demoLines || liveLines === demoLines) return false;
  return liveLines === storedLines;
}

/**
 * Learner clock. narrate receives the lines Teach sends to Gemini TTS
 * (persona "attending" in the student session). This does not call the network.
 */
export async function playRecordedGuide(finding: Finding): Promise<RecordedTourPlay> {
  const guide = resolveTeachingGuide(finding);
  if (!guide) throw new Error("Recorded finding has no teaching guide.");
  const said: string[] = [];
  const log: string[] = [];
  const walk: number[] = [];
  let slice = guide.start.sliceIndex;
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        if (event.type === "slice") {
          slice = event.index;
          log.push(`slice:${event.index}`);
          walk.push(event.index);
        } else if (event.type === "series") {
          log.push("series");
        }
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async (ww, wc) => {
        log.push(`window:${ww}/${wc}`);
      },
      showState: async (state) => {
        if (state.zoom != null) log.push(`zoom:${state.zoom}`);
      },
      overlay: {
        animateTo: async () => {
          log.push("point");
        },
      },
    },
    {
      narrate: async (text) => {
        said.push(text);
      },
      sliceStepMs: 0,
      timeScale: 0,
      landmark: finding.landmark,
      withholdTerms: finding.label ? [finding.label] : undefined,
    }
  );
  await ctrl.finished;
  return { said, log, walk, landedSlice: slice };
}

export function buildRecordedTutorFixture(finding: Finding): TutorEvalFixture {
  const template = getPublicCaseTemplate(LIDC_CASE_ID);
  if (!template) throw new Error(`Missing public case template ${LIDC_CASE_ID}.`);
  const guide = resolveTeachingGuide(finding);
  const spoken = authoredGuideLines(guide).join(" ");
  if (!spoken.trim()) throw new Error("Recorded guide has nothing to say.");
  return {
    id: "lidc-finding-1-recorded",
    phi: "none",
    notes:
      "Teacher-recorded LIDC finding 1. resolveTeachingGuide rebuilds from the track, so a stored demo guide does not win. No pixels, no PHI.",
    mode: "guided",
    initialViewer: {
      sliceIndex: 0,
      windowWidth: 400,
      windowCenter: 40,
      zoom: 1,
      seriesInstanceUID: finding.seriesInstanceUID,
    },
    case: {
      caseId: LIDC_CASE_ID,
      title: template.title,
      modality: template.modality,
      pacsbinBaseUrl: "https://eval.flowrad.local/viewer/lidc-nodule-search",
      orgId: "org_eval",
      status: "published",
      specialty: template.specialty,
      difficulty: template.difficulty,
      system: template.system,
      tags: ["eval", "LIDC", "recorded"],
      clinicalHistory: template.clinicalHistory,
      technique: template.technique,
      primaryDiagnosis: template.primaryDiagnosis,
      differentials: template.differentials,
      targetLevel: template.targetLevel,
      learningObjectives: template.learningObjectives,
      discussion:
        "Eval fixture for a teacher-recorded take on the first LIDC finding. The pearl is the authored text plus the transcript line that names the level. No pixels are loaded.",
      references: [],
      findings: [finding],
    },
    beats: [
      {
        id: "beat-recorded",
        findingId: finding.id,
        prompt:
          "Teach the opening pass from the recorded take. Drive the viewer, then name the level.",
        distinctiveTerms: ["carina"],
        drivingNarration: spoken,
        chatbotNarration:
          "Follow this slice. Begin at the carina and survey both lungs before the mediastinum.",
      },
    ],
  };
}

function checkPass(score: SessionScore, id: string): boolean {
  const check = score.beats[0]?.checks.find((item) => item.id === id);
  return check?.pass === true;
}

export async function evaluateRecordedTour(
  applied: AppliedRecording,
  play: RecordedTourPlay
): Promise<RecordedTourReport> {
  const fixture = parseTutorFixture(buildRecordedTutorFixture(applied.finding));
  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  const silent = await scoreTutorSession(fixture, silentToolsTutor, "silent tools");
  const driver = await scoreTutorSession(fixture, guideReplayTutor, "recorded-guide replay");
  const lung = play.log.indexOf("window:1500/-600");
  const slicesBeforeLung = play.log.slice(0, Math.max(0, lung)).filter((line) => line.startsWith("slice:"));
  return {
    applied,
    play,
    superseded: demoGuideSuperseded(applied.demo, applied.finding),
    walked: lung > 0 && slicesBeforeLung.length >= 3 && play.walk.at(-1) === applied.finding.sliceIndex,
    textOnly,
    silent,
    driver,
    spokenBeat: checkPass(driver, "spoken_beat"),
    driveFirst: checkPass(driver, "look_with_drive"),
  };
}

export function recordedTourContractHeld(report: RecordedTourReport): boolean {
  return (
    report.superseded &&
    report.walked &&
    report.spokenBeat &&
    report.driveFirst &&
    report.driver.hardPass === true &&
    report.driver.fidelityTaught === true &&
    report.driver.worldClass === true &&
    report.driver.holes.length === 0 &&
    report.textOnly.hardPass === false &&
    checkPass(report.silent, "spoken_beat") === false
  );
}

export function formatRecordedTourReport(report: RecordedTourReport): string {
  const acts = report.applied.finding.teachingGuide?.beats.map((beat) => beat.act).join(" → ");
  const held = recordedTourContractHeld(report);
  const fail = (score: SessionScore, id: string) => {
    const check = score.beats[0]?.checks.find((item) => item.id === id);
    return check?.pass ? "PASS" : `FAIL (${check?.detail ?? "missing"})`;
  };
  return [
    "RECORD → GUIDE → PLAY",
    `  case                ${report.applied.finding.id} on ${LIDC_CASE_ID}`,
    `  alignment           ${report.applied.alignment}`,
    `  precedence          track rebuilds; stored demo guide ignored`,
    `  acts                ${acts}`,
    `  scroll-walk         ${report.play.walk.length} slices, landing ${report.play.landedSlice}`,
    `  demo superseded     ${report.superseded ? "YES" : "NO"}`,
    `  spoken_beat         ${fail(report.driver, "spoken_beat")}`,
    `  drive-first         ${fail(report.driver, "look_with_drive")}`,
    `  text-only           ${report.textOnly.hardPass ? "PASS (bug)" : "FAIL (required)"}`,
    `  silent spoken_beat  ${fail(report.silent, "spoken_beat")} (required fail)`,
    `  fidelity            ${report.driver.fidelityTaught ? "TAUGHT" : "NOT TAUGHT"}    world ${report.driver.worldClass ? "YES" : "NO"}`,
    `  CONTRACT            ${held ? "HELD" : "BROKEN"}`,
  ].join("\n");
}

export async function runRecordedTour(): Promise<RecordedTourReport> {
  const applied = loadAppliedLidcRecording();
  const play = await playRecordedGuide(applied.finding);
  return evaluateRecordedTour(applied, play);
}

/** Acts the cleaned script must contain, in order. Search is the scroll-walk. */
export function recordedActOrder(guide: TeachingGuide | null | undefined): string[] {
  return (guide?.beats ?? []).map((beat) => beat.act ?? "");
}
