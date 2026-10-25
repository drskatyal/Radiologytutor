/**
 * Tutor eval — would a registrar feel taught at the workstation?
 *
 * The anti-chatbot bar is unchanged: a turn with no viewer tools scores 0.
 * Human-teacher fidelity is stricter. The fixture's teachingGuide is the
 * consultant's sequence:
 *
 *   scroll → correct window → zoom (when the teacher zoomed) → point → say it
 *
 * `show_finding` is one tool, but the simulator records that gesture as
 * scroll, then window, then laser — the order the registrar sees. Saying the
 * finding before that viewport is up fails. A scroll path that walks away
 * from the slice, or onto the other finding, fails.
 *
 * `zoom_to` (and its alias `set_zoom`) is in the live registry. A guide that
 * zooms is a hard step: skip it, or place it outside window → zoom → point,
 * and the turn fails. The reference emits that sequence itself.
 *
 * Pass / fail criteria: docs/TUTOR_EVAL.md.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clickHitsFinding } from "../clickFinding";
import { buildPerformancePlan, splitSentences } from "../performancePlan";
import type { CaseData, Finding } from "../types";
import { HARNESS_VIEWER_TOOLS, type HarnessViewerAction } from "./tools";

/** WW/WC tolerance. 400/40 vs 1500/-600 fails; a 10-unit nudge passes. */
export const VOI_TOLERANCE = 20;
/** Zoom factor tolerance. 2.2 vs 2.15 passes; 2.2 vs 1 does not. */
export const ZOOM_TOLERANCE = 0.05;

/** Actions the registry does not have yet. The simulator already applies them. */
/** scroll_to / zoom_to / set_zoom are live harness tools. */
export type FutureViewerAction = Extract<
  HarnessViewerAction,
  { type: "scroll_to" | "zoom_to" | "set_zoom" }
>;

export type EvalAction = HarnessViewerAction;

export type TeachingGuideAction =
  | "set_window"
  | "show_finding"
  | "point_to"
  | "next_in_tour"
  | "prev_in_tour"
  | "scroll_to"
  | "zoom_to";

/** One step of the teacher script. `t` is the teacher's clock, used for order only. */
export type TeachingGuideStep = {
  t: number;
  action: TeachingGuideAction;
  findingId?: string;
  windowWidth?: number;
  windowCenter?: number;
  sliceIndex?: number;
  zoom?: number;
  x_pct?: number;
  y_pct?: number;
};

export type TutorEvalBeat = {
  id: string;
  findingId: string;
  prompt: string;
  /** Terms that must appear in the narration while THIS finding is on screen. */
  distinctiveTerms: string[];
  /** Reference speech for a tutor that also drives. */
  drivingNarration: string;
  /** Fluent speech with no tool calls — must still fail the bar. */
  chatbotNarration: string;
  /**
   * Expected teach beats. Optional: when absent, derived from the finding track.
   * Future zoom/scroll steps live here even though today's tutor cannot emit them.
   */
  teachingGuide?: TeachingGuideStep[];
};

export type InitialViewer = {
  sliceIndex: number;
  windowWidth: number;
  windowCenter: number;
  zoom?: number;
  seriesInstanceUID?: string;
};

export type TutorEvalFixture = {
  id: string;
  phi: "none";
  notes?: string;
  mode: "guided";
  initialViewer: InitialViewer;
  case: CaseData;
  beats: TutorEvalBeat[];
};

export type SimViewer = {
  sliceIndex: number | null;
  windowWidth: number | null;
  windowCenter: number | null;
  zoom: number | null;
  pointer: { x: number; y: number } | null;
  activeFindingId: string | null;
  seriesInstanceUID: string | null;
};

export type ViewerEffect = {
  type: "scroll" | "window" | "point" | "zoom" | "series";
  seq: number;
  sub: number;
  source: string;
  findingId?: string;
  sliceIndex?: number;
  windowWidth?: number;
  windowCenter?: number;
  x_pct?: number;
  y_pct?: number;
  zoom?: number;
  seriesInstanceUID?: string;
};

export type TutorTurn = {
  answer: string;
  actions: EvalAction[];
};

export type TutorEvalContext = {
  fixture: TutorEvalFixture;
  beat: TutorEvalBeat;
  finding: Finding;
  viewer: SimViewer;
  history: { role: "user" | "assistant"; text: string }[];
};

export type TutorAgent = (ctx: TutorEvalContext) => TutorTurn | Promise<TutorTurn>;

export type HardCheck = {
  id: string;
  pass: boolean;
  detail: string;
};

export type FidelityPhaseName = "scroll" | "window" | "zoom" | "point" | "speech";
export type FidelityPhaseStatus = "met" | "missed" | "blocked" | "n/a";

export type FidelityPhase = {
  phase: FidelityPhaseName;
  status: FidelityPhaseStatus;
  detail: string;
};

/** What a consultant would do on this beat, and whether this turn did it. */
export type BeatFidelity = {
  consultant: string;
  taught: boolean;
  phases: FidelityPhase[];
};

export type BeatReport = {
  beatId: string;
  findingId: string;
  label: string;
  tools: string[];
  drive: string;
  checks: HardCheck[];
  holes: string[];
  fidelity: BeatFidelity;
};

export type SessionScore = {
  fixtureId: string;
  tutorName: string;
  beats: BeatReport[];
  hardPass: boolean;
  hardPassed: number;
  hardTotal: number;
  /**
   * 100 only when every hard check passed. Any drive or narration failure
   * scores 0 — a decent paragraph does not earn partial credit.
   * The checks fraction is still printed so a failure is diagnosable.
   */
  hardScore: number;
  holes: string[];
  /**
   * Every beat was taught: scroll, window, zoom when required, point, then
   * the right words, with no blocked phase. A missing zoom on a guide that
   * zooms keeps this false, because zoom_to is a live tool.
   */
  fidelityTaught: boolean;
  fidelityMet: number;
  fidelityRequired: number;
  /** Hard pass, fidelity taught, and no craft holes. */
  worldClass: boolean;
};

const GUIDE_ACTIONS = new Set<TeachingGuideAction>([
  "set_window",
  "show_finding",
  "point_to",
  "next_in_tour",
  "prev_in_tour",
  "scroll_to",
  "zoom_to",
]);

const LOOK_CUE = /^(look|see|watch|follow)\b/i;

export function defaultFixturePath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/tutor-eval/apical-pneumothorax.json"
  );
}

export function loadTutorFixture(path = defaultFixturePath()): TutorEvalFixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseTutorFixture(raw);
}

export function parseTutorFixture(raw: unknown): TutorEvalFixture {
  if (!raw || typeof raw !== "object") throw new Error("Tutor fixture is not an object.");
  const doc = raw as TutorEvalFixture;
  assertNoPhi(JSON.stringify(raw));
  if (doc.phi !== "none") throw new Error('Tutor fixture phi must be "none".');
  if (!doc.id) throw new Error("Tutor fixture is missing id.");
  if (!doc.case?.findings?.length) throw new Error("Tutor fixture case has no findings.");
  if (!doc.beats?.length) throw new Error("Tutor fixture has no beats.");
  if (!doc.initialViewer) throw new Error("Tutor fixture is missing initialViewer.");

  const ids = new Set<string>();
  for (const finding of doc.case.findings) {
    if (!finding.id || ids.has(finding.id)) {
      throw new Error(`Duplicate or empty finding id "${finding.id ?? ""}".`);
    }
    ids.add(finding.id);
    if (!markerOk(finding.marker?.x_pct, finding.marker?.y_pct)) {
      throw new Error(`Finding ${finding.id} marker is outside [0,1].`);
    }
    if (finding.sliceIndex == null || !Number.isFinite(finding.sliceIndex)) {
      throw new Error(`Finding ${finding.id} needs a sliceIndex.`);
    }
  }

  for (const beat of doc.beats) {
    if (!ids.has(beat.findingId)) {
      throw new Error(`Beat ${beat.id} points at unknown finding ${beat.findingId}.`);
    }
    if (!beat.distinctiveTerms?.length) {
      throw new Error(`Beat ${beat.id} has no distinctive terms.`);
    }
    if (!beat.drivingNarration?.trim() || !beat.chatbotNarration?.trim()) {
      throw new Error(`Beat ${beat.id} needs both narrations.`);
    }
    if (!beat.prompt?.trim()) throw new Error(`Beat ${beat.id} needs a prompt.`);
    const guide = beat.teachingGuide ?? [];
    for (const step of guide) {
      if (!GUIDE_ACTIONS.has(step.action)) {
        throw new Error(`Beat ${beat.id} has unknown guide action ${step.action}.`);
      }
      if (!Number.isFinite(step.t)) throw new Error(`Beat ${beat.id} guide step missing t.`);
    }
  }

  const first = findingById(doc, doc.beats[0].findingId);
  const init = doc.initialViewer;
  const sameSlice = init.sliceIndex === first.sliceIndex;
  const sameWindow =
    first.windowWidth != null &&
    first.windowCenter != null &&
    voiMatches(init.windowWidth, init.windowCenter, first.windowWidth, first.windowCenter);
  if (sameSlice && sameWindow) {
    throw new Error(
      "Initial viewer already shows the first finding. The eval would not be able to tell a driver from a chatbot."
    );
  }
  return doc;
}

/** SSN-shaped numbers and DICOM patient tags do not belong in a fixture. */
export function assertNoPhi(text: string): void {
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) {
    throw new Error("Tutor fixture looks like it contains an SSN.");
  }
  if (/patient\s*name|PatientName|PatientBirthDate|"birthDate"/i.test(text)) {
    throw new Error("Tutor fixture looks like it contains patient identifiers.");
  }
}

export function voiMatches(
  ww: number | null | undefined,
  wc: number | null | undefined,
  targetWw: number,
  targetWc: number
): boolean {
  if (ww == null || wc == null || !Number.isFinite(ww) || !Number.isFinite(wc)) return false;
  return Math.abs(ww - targetWw) <= VOI_TOLERANCE && Math.abs(wc - targetWc) <= VOI_TOLERANCE;
}

/**
 * Pedagogical sequence from a recorded track: one scroll to the landing
 * slice, then the window, then zoom if the teacher zoomed, then the point.
 * Intermediate scroll ticks are not required steps. `t` increases in that
 * human order so a beat with no authored guide still scores scroll → window
 * → zoom → point.
 */
export function teachingGuideFromTrack(finding: Finding): TeachingGuideStep[] {
  let ww = finding.windowWidth ?? finding.track?.start.ww;
  let wc = finding.windowCenter ?? finding.track?.start.wc;
  let zoom: number | undefined;
  let x = finding.marker.x_pct;
  let y = finding.marker.y_pct;
  for (const event of finding.track?.events ?? []) {
    if (event.type === "voi") {
      ww = event.ww;
      wc = event.wc;
    } else if (event.type === "camera") {
      zoom = event.zoom;
    } else if (event.type === "cursor") {
      x = event.x;
      y = event.y;
    }
  }
  const slice = finding.sliceIndex ?? finding.track?.start.sliceIndex ?? 0;
  let t = 0;
  const steps: TeachingGuideStep[] = [
    { t: t++, action: "scroll_to", sliceIndex: slice, findingId: finding.id },
  ];
  if (ww != null && wc != null) {
    steps.push({
      t: t++,
      action: "set_window",
      windowWidth: ww,
      windowCenter: wc,
      findingId: finding.id,
    });
  }
  if (zoom != null) {
    steps.push({ t: t++, action: "zoom_to", zoom, findingId: finding.id });
  }
  steps.push({ t: t++, action: "point_to", findingId: finding.id, x_pct: x, y_pct: y });
  return steps;
}

export function resolveTeachingGuide(beat: TutorEvalBeat, finding: Finding): TeachingGuideStep[] {
  const guide = beat.teachingGuide?.length ? beat.teachingGuide : teachingGuideFromTrack(finding);
  return guide.slice().sort((a, b) => a.t - b.t);
}

/** True when today's tool registry can produce this guide step's effect. */
export function guideStepIsGating(step: TeachingGuideStep): boolean {
  if (step.action === "zoom_to") {
    return registryHas("zoom_to");
  }
  if (step.action === "scroll_to") {
    // show_finding / next_in_tour / prev_in_tour seat the slice today.
    return registryHas("show_finding") || registryHas("scroll_to");
  }
  return registryHas(step.action);
}

function registryHas(name: string): boolean {
  return HARNESS_VIEWER_TOOLS.some((tool) => tool.name === name);
}

export function initialViewer(fixture: TutorEvalFixture): SimViewer {
  const init = fixture.initialViewer;
  return {
    sliceIndex: init.sliceIndex,
    windowWidth: init.windowWidth,
    windowCenter: init.windowCenter,
    zoom: init.zoom ?? 1,
    pointer: null,
    activeFindingId: null,
    seriesInstanceUID: init.seriesInstanceUID ?? null,
  };
}

/**
 * Scroll, then the authored window, then zoom when the guide zoomed, then
 * the laser. `point_to` with the finding id seats the finding if it is not
 * already active, so the laser is the last visible effect — after the zoom.
 */
export function humanTeachActions(finding: Finding, guide: TeachingGuideStep[]): EvalAction[] {
  const zoom = guide.find((step) => step.action === "zoom_to");
  const slice = finding.sliceIndex ?? zoom?.sliceIndex ?? 0;
  const actions: EvalAction[] = [{ type: "scroll_to", sliceIndex: slice }];
  if (finding.windowWidth != null && finding.windowCenter != null) {
    actions.push({
      type: "set_window",
      windowWidth: finding.windowWidth,
      windowCenter: finding.windowCenter,
    });
  }
  if (zoom?.zoom != null) actions.push({ type: "zoom_to", zoom: zoom.zoom });
  actions.push({ type: "point_to", findingId: finding.id });
  return actions;
}

/**
 * Reference tutor. Emits the consultant sequence with the live tools,
 * including `zoom_to` when the guide zooms. `show_finding` alone is not
 * this path: it never leans in.
 */
export function viewerDrivingTutor(ctx: TutorEvalContext): TutorTurn {
  const guide = resolveTeachingGuide(ctx.beat, ctx.finding);
  return { answer: ctx.beat.drivingNarration, actions: humanTeachActions(ctx.finding, guide) };
}

/** Fluent radiologist-sounding answer. No tools. This must fail. */
export function textOnlyTutor(ctx: TutorEvalContext): TutorTurn {
  return { answer: ctx.beat.chatbotNarration, actions: [] };
}

export async function scoreTutorSession(
  fixture: TutorEvalFixture,
  tutor: TutorAgent,
  tutorName: string
): Promise<SessionScore> {
  let viewer = initialViewer(fixture);
  const history: { role: "user" | "assistant"; text: string }[] = [];
  const beats: BeatReport[] = [];

  for (const beat of fixture.beats) {
    const finding = findingById(fixture, beat.findingId);
    const snapshot = cloneViewer(viewer);
    const turn = await tutor({ fixture, beat, finding, viewer: snapshot, history });
    const applied = applyActions(snapshot, turn.actions ?? [], fixture.case.findings);
    viewer = applied.viewer;
    const guide = resolveTeachingGuide(beat, finding);
    const judged = scoreBeat({
      fixture,
      beat,
      finding,
      before: snapshot,
      after: viewer,
      answer: turn.answer ?? "",
      actions: turn.actions ?? [],
      effects: applied.effects,
      seated: applied.seated,
      guide,
    });
    const holes = craftHoles(guide, finding, applied.effects);
    beats.push({
      beatId: beat.id,
      findingId: finding.id,
      label: finding.label,
      tools: (turn.actions ?? []).map((action) => action.type).filter((type) => type !== "none"),
      drive: formatDrive(applied.effects),
      checks: judged.checks,
      holes,
      fidelity: judged.fidelity,
    });
    history.push({ role: "user", text: beat.prompt });
    history.push({ role: "assistant", text: turn.answer ?? "" });
  }

  const hard = beats.flatMap((beat) => beat.checks);
  const hardPassed = hard.filter((check) => check.pass).length;
  const hardTotal = hard.length;
  const hardPass = hardTotal > 0 && hard.every((check) => check.pass);
  const holes = beats.flatMap((beat) => beat.holes.map((hole) => `${beat.beatId}: ${hole}`));
  const phases = beats.flatMap((beat) => beat.fidelity.phases.filter((phase) => phase.status !== "n/a"));
  const fidelityMet = phases.filter((phase) => phase.status === "met").length;
  const fidelityTaught = beats.length > 0 && beats.every((beat) => beat.fidelity.taught);
  return {
    fixtureId: fixture.id,
    tutorName,
    beats,
    hardPass,
    hardPassed,
    hardTotal,
    hardScore: hardPass ? 100 : 0,
    holes,
    fidelityTaught,
    fidelityMet,
    fidelityRequired: phases.length,
    worldClass: hardPass && fidelityTaught && holes.length === 0,
  };
}

export function harnessContractHeld(textOnly: SessionScore, driver: SessionScore): boolean {
  return textOnly.hardPass === false && driver.hardPass === true;
}

type Rank = { seq: number; sub: number };

function scoreBeat(input: {
  fixture: TutorEvalFixture;
  beat: TutorEvalBeat;
  finding: Finding;
  before: SimViewer;
  after: SimViewer;
  answer: string;
  actions: EvalAction[];
  effects: ViewerEffect[];
  seated: string[];
  guide: TeachingGuideStep[];
}): { checks: HardCheck[]; fidelity: BeatFidelity } {
  const { fixture, beat, finding, before, after, answer, actions, effects, seated, guide } = input;
  const live = actions.filter((action) => action.type !== "none");
  const text = answer.replace(/\s+/g, " ").trim();
  const sentences = splitSentences(text);
  const plan = buildPerformancePlan(text, live);
  const firstSpoken = plan.find((item) => item.text.trim());

  const checks: HardCheck[] = [];

  checks.push(
    live.length === 0
      ? fail(
          "text_only",
          "No viewer tool fired. A correct paragraph in front of a still image is a chatbot."
        )
      : pass("text_only", `Tools fired: ${live.map((action) => action.type).join(", ")}.`)
  );

  checks.push(
    text
      ? pass("narration_present", "There is something to say.")
      : fail("narration_present", "The viewer moved, or nothing happened, and the tutor said nothing.")
  );

  if (!text) {
    checks.push(fail("look_cue", "No first sentence to tell the registrar where to look."));
  } else if (LOOK_CUE.test(sentences[0] ?? text)) {
    checks.push(pass("look_cue", `Opens with a look-cue: "${sentences[0]}".`));
  } else {
    checks.push(
      fail(
        "look_cue",
        `First sentence is not a look-cue: "${sentences[0] ?? text}". Start with look / see / watch / follow.`
      )
    );
  }

  const mentioned = beat.distinctiveTerms.filter((term) => mentions(text, term));
  checks.push(
    mentioned.length > 0
      ? pass("narration_on_screen", `Narration names this finding (${mentioned.join(", ")}).`)
      : fail(
          "narration_on_screen",
          `Narration never names ${finding.label}. Needed one of: ${beat.distinctiveTerms.join(", ")}.`
        )
  );

  const laterTerms = laterDistinctiveTerms(fixture, finding);
  const spoiled = laterTerms.filter((term) => mentions(text, term));
  checks.push(
    spoiled.length === 0
      ? pass("narration_ahead", "Did not lecture a finding that is not on screen yet.")
      : fail(
          "narration_ahead",
          `Talked about a later finding (${spoiled.join(", ")}) while teaching ${finding.label}.`
        )
  );

  const leaked = leakedInternals(text, fixture.case.findings.map((item) => item.id));
  checks.push(
    leaked
      ? fail("narration_hygiene", `Speech leaked viewer internals (${leaked}).`)
      : pass("narration_hygiene", "No finding ids or normalized coordinates in the speech.")
  );

  if (!text) {
    checks.push(fail("look_with_drive", "Nothing was spoken, so speech and the drive cannot start together."));
  } else if (!firstSpoken || firstSpoken.actions.length === 0) {
    checks.push(
      fail(
        "look_with_drive",
        "The first spoken sentence carries no viewer action. The registrar hears a lecture while the scan sits still."
      )
    );
  } else {
    checks.push(
      pass(
        "look_with_drive",
        `First sentence drives the viewer (${firstSpoken.actions.map((action) => action.type).join(", ")}).`
      )
    );
  }

  const wrong = seated.filter((id) => id !== finding.id);
  if (seated.length === 0) {
    checks.push(
      fail("seated_finding", `Never seated ${finding.id}. The active slice is not this finding.`)
    );
  } else if (wrong.length > 0) {
    checks.push(
      fail("seated_finding", `Seated the wrong finding (${wrong.join(", ")}). This beat is ${finding.id}.`)
    );
  } else {
    checks.push(pass("seated_finding", `Seated ${finding.id}.`));
  }

  const authoredWw = finding.windowWidth;
  const authoredWc = finding.windowCenter;
  const windowed = effects.some((effect) => effect.type === "window");
  const badWindows =
    authoredWw == null || authoredWc == null
      ? []
      : effects.filter(
          (effect) =>
            effect.type === "window" &&
            !voiMatches(effect.windowWidth, effect.windowCenter, authoredWw, authoredWc)
        );
  checks.push(
    badWindows.length === 0
      ? pass(
          "hallucinated_window",
          windowed
            ? "Every window effect matches the authored VOI."
            : "No window was set. That is a miss, not an invented WW/WC — see landing_window."
        )
      : fail(
          "hallucinated_window",
          `Invented WW/WC ${badWindows
            .map((effect) => `${effect.windowWidth}/${effect.windowCenter}`)
            .join(", ")}. Authored ${authoredWw}/${authoredWc}.`
        )
  );

  checks.push(pointerBeforeWindow(before, finding, effects));
  checks.push(orderCheck(guide, finding, effects));
  checks.push(humanSequence(before, finding, effects, guide));
  checks.push(noRandomJump(before, finding, effects, fixture.case.findings));
  checks.push(
    speechOnViewport(before, beat.distinctiveTerms, finding, answer, actions, fixture.case.findings, guide)
  );

  checks.push(
    after.sliceIndex === finding.sliceIndex
      ? pass("landing_slice", `Slice ${after.sliceIndex}.`)
      : fail(
          "landing_slice",
          `Ended on slice ${after.sliceIndex ?? "none"}; ${finding.label} is slice ${finding.sliceIndex}.`
        )
  );

  checks.push(
    authoredWw != null &&
      authoredWc != null &&
      voiMatches(after.windowWidth, after.windowCenter, authoredWw, authoredWc)
      ? pass("landing_window", `Window ${after.windowWidth}/${after.windowCenter}.`)
      : fail(
          "landing_window",
          `Ended on WW/WC ${after.windowWidth ?? "none"}/${after.windowCenter ?? "none"}; authored ${authoredWw}/${authoredWc}. Started at ${before.windowWidth}/${before.windowCenter}.`
        )
  );

  const hit =
    after.pointer != null &&
    clickHitsFinding(finding.marker, after.pointer.x, after.pointer.y);
  checks.push(
    hit
      ? pass(
          "landing_pointer",
          `Pointer (${after.pointer!.x.toFixed(3)}, ${after.pointer!.y.toFixed(3)}) hits the marker.`
        )
      : fail(
          "landing_pointer",
          `Pointer ${
            after.pointer
              ? `(${after.pointer.x.toFixed(3)}, ${after.pointer.y.toFixed(3)})`
              : "never moved"
          }. Marker is (${finding.marker.x_pct.toFixed(3)}, ${finding.marker.y_pct.toFixed(3)}).`
        )
  );

  return { checks, fidelity: beatFidelity(input, checks) };
}

const ALREADY_SCROLL: Rank = { seq: -1, sub: 0 };
const ALREADY_WINDOW: Rank = { seq: -1, sub: 1 };
const ALREADY_POINT: Rank = { seq: -1, sub: 2 };

function scrollRank(before: SimViewer, finding: Finding, effects: ViewerEffect[]): Rank | null {
  const landed = earliest(
    effects.filter((effect) => effect.type === "scroll" && effect.sliceIndex === finding.sliceIndex)
  );
  if (landed) return landed;
  if (before.sliceIndex === finding.sliceIndex) return ALREADY_SCROLL;
  return null;
}

function windowRank(before: SimViewer, finding: Finding, effects: ViewerEffect[]): Rank | null {
  const ww = finding.windowWidth;
  const wc = finding.windowCenter;
  if (ww == null || wc == null) return null;
  const landed = earliest(
    effects.filter(
      (effect) => effect.type === "window" && voiMatches(effect.windowWidth, effect.windowCenter, ww, wc)
    )
  );
  if (landed) return landed;
  if (voiMatches(before.windowWidth, before.windowCenter, ww, wc)) return ALREADY_WINDOW;
  return null;
}

function pointRank(before: SimViewer, finding: Finding, effects: ViewerEffect[]): Rank | null {
  const landed = earliest(effects.filter((effect) => effect.type === "point" && pointHits(effect, finding)));
  if (landed) return landed;
  if (
    before.pointer &&
    clickHitsFinding(finding.marker, before.pointer.x, before.pointer.y)
  ) {
    return ALREADY_POINT;
  }
  return null;
}

function guideZoom(guide: TeachingGuideStep[]): TeachingGuideStep | undefined {
  return guide.find((step) => step.action === "zoom_to" && step.zoom != null);
}

function zoomRank(guide: TeachingGuideStep[], effects: ViewerEffect[]): Rank | null {
  const step = guideZoom(guide);
  if (!step?.zoom) return null;
  const target = step.zoom;
  return earliest(
    effects.filter(
      (effect) =>
        effect.type === "zoom" && effect.zoom != null && Math.abs(effect.zoom - target) <= ZOOM_TOLERANCE
    )
  );
}

function humanSequence(
  before: SimViewer,
  finding: Finding,
  effects: ViewerEffect[],
  guide: TeachingGuideStep[]
): HardCheck {
  const scroll = scrollRank(before, finding, effects);
  const window = windowRank(before, finding, effects);
  const point = pointRank(before, finding, effects);
  if (!scroll || !window || !point || !rankLess(scroll, window) || !rankLess(window, point)) {
    return fail(
      "human_sequence",
      "A teacher scrolls to the slice, then sets the window, then points. This turn did not do those three in that order."
    );
  }
  const zoom = guideZoom(guide);
  if (zoom?.zoom != null) {
    const placed = zoomRank(guide, effects);
    const inOrder = placed != null && rankLess(window, placed) && rankLess(placed, point);
    if (!inOrder && placed == null && !registryHas("zoom_to")) {
      return pass(
        "human_sequence",
        `scroll → window → point. Zoom ${zoom.zoom}× is on the guide and blocked until zoom_to is registered. That is a hole, not a pass on craft.`
      );
    }
    if (!inOrder) {
      return fail(
        "human_sequence",
        `Zoom ${zoom.zoom}× has to land after the window and before the laser. Out-of-order zoom fails now. A missing zoom fails too, the moment zoom_to joins the registry.`
      );
    }
    return pass("human_sequence", `scroll → window → zoom ${zoom.zoom}× → point.`);
  }
  return pass("human_sequence", "scroll → window → point, each strictly after the one before.");
}

function noRandomJump(
  before: SimViewer,
  finding: Finding,
  effects: ViewerEffect[],
  findings: Finding[]
): HardCheck {
  const target = finding.sliceIndex;
  if (target == null) return pass("no_random_jump", "Finding has no slice to approach.");
  const otherSlices = new Set(
    findings
      .filter((item) => item.id !== finding.id && item.sliceIndex != null && item.sliceIndex !== target)
      .map((item) => item.sliceIndex as number)
  );
  let prev = before.sliceIndex;
  const path: number[] = [];
  for (const effect of effects) {
    if (effect.type !== "scroll" || effect.sliceIndex == null) continue;
    const slice = effect.sliceIndex;
    path.push(slice);
    const walked = [before.sliceIndex, ...path].filter((index) => index != null).join(" → ");
    if (otherSlices.has(slice)) {
      return fail(
        "no_random_jump",
        `Scrolled onto another finding's slice ${slice} while teaching ${finding.label}. Path ${walked}.`
      );
    }
    if (prev == null) {
      prev = slice;
      continue;
    }
    const dist = Math.abs(slice - target);
    const prevDist = Math.abs(prev - target);
    const sideways = slice !== target && slice !== prev && dist === prevDist;
    if (dist > prevDist || sideways) {
      return fail(
        "no_random_jump",
        `Slice ${prev} → ${slice} does not approach slice ${target}. Path ${walked}.`
      );
    }
    prev = slice;
  }
  if (path.length === 0 && before.sliceIndex !== target) {
    return fail(
      "no_random_jump",
      `Never scrolled. Stayed on slice ${before.sliceIndex}; ${finding.label} is slice ${target}.`
    );
  }
  const walked = [before.sliceIndex, ...path].filter((index) => index != null).join(" → ");
  return pass(
    "no_random_jump",
    path.length === 0 ? `Already on slice ${target}.` : `Path ${walked} approaches slice ${target}.`
  );
}

function speechOnViewport(
  before: SimViewer,
  terms: string[],
  finding: Finding,
  answer: string,
  actions: EvalAction[],
  findings: Finding[],
  guide: TeachingGuideStep[]
): HardCheck {
  const live = actions.filter((action) => action.type !== "none");
  const text = answer.replace(/\s+/g, " ").trim();
  const plan = buildPerformancePlan(text, live);
  let viewer = cloneViewer(before);
  const off: { text: string; view: SimViewer }[] = [];
  let named = false;
  for (const sentenceBeat of plan) {
    const sentence = sentenceBeat.text.trim();
    if (sentence && terms.some((term) => mentions(sentence, term))) {
      named = true;
      if (!viewportReady(viewer, finding, guide)) {
        off.push({ text: sentence, view: cloneViewer(viewer) });
      }
    }
    if (sentenceBeat.actions.length > 0) {
      viewer = applyActions(viewer, sentenceBeat.actions as EvalAction[], findings).viewer;
    }
  }
  if (!named) {
    return fail(
      "speech_on_viewport",
      "The finding was never named on a sentence the registrar could attach to the image."
    );
  }
  if (off.length > 0) {
    const view = off[0].view;
    return fail(
      "speech_on_viewport",
      `Said "${clip(off[0].text)}" before the finding was on screen (slice ${view.sliceIndex ?? "none"}, WW/WC ${view.windowWidth ?? "none"}/${view.windowCenter ?? "none"}, ${view.pointer ? "pointer up" : "no pointer"}). Say it after the laser.`
    );
  }
  return pass(
    "speech_on_viewport",
    "The finding was named only once slice, window, and laser were already up."
  );
}

function viewportReady(viewer: SimViewer, finding: Finding, guide: TeachingGuideStep[]): boolean {
  if (viewer.sliceIndex !== finding.sliceIndex) return false;
  if (
    finding.windowWidth == null ||
    finding.windowCenter == null ||
    !voiMatches(viewer.windowWidth, viewer.windowCenter, finding.windowWidth, finding.windowCenter)
  ) {
    return false;
  }
  if (!viewer.pointer || !clickHitsFinding(finding.marker, viewer.pointer.x, viewer.pointer.y)) {
    return false;
  }
  const zoom = guideZoom(guide);
  if (zoom?.zoom != null && registryHas("zoom_to")) {
    if (viewer.zoom == null || Math.abs(viewer.zoom - zoom.zoom) > ZOOM_TOLERANCE) return false;
  }
  return true;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function beatFidelity(
  input: {
    beat: TutorEvalBeat;
    finding: Finding;
    before: SimViewer;
    effects: ViewerEffect[];
    guide: TeachingGuideStep[];
  },
  checks: HardCheck[]
): BeatFidelity {
  const { beat, finding, before, effects, guide } = input;
  const scroll = scrollRank(before, finding, effects);
  const window = windowRank(before, finding, effects);
  const point = pointRank(before, finding, effects);
  const zoomStep = guideZoom(guide);
  const zoom = zoomRank(guide, effects);
  const speechOk = checks.find((check) => check.id === "speech_on_viewport")?.pass === true;

  const phases: FidelityPhase[] = [];

  phases.push(
    !scroll
      ? missedPhase("scroll", `Never reached slice ${finding.sliceIndex}.`)
      : metPhase("scroll", `Slice ${finding.sliceIndex}.`)
  );

  if (!window) {
    phases.push(missedPhase("window", "Window never matched the authored VOI."));
  } else if (!scroll || !rankLess(scroll, window)) {
    phases.push(missedPhase("window", "Window did not come after the scroll."));
  } else {
    phases.push(metPhase("window", "After the scroll."));
  }

  if (!zoomStep) {
    phases.push(naPhase("zoom", "The teacher did not zoom on this finding."));
  } else if (
    zoom &&
    window &&
    point &&
    rankLess(window, zoom) &&
    rankLess(zoom, point)
  ) {
    phases.push(metPhase("zoom", `${zoomStep.zoom}× between the window and the laser.`));
  } else if (zoom) {
    phases.push(missedPhase("zoom", "Zoom was not between the window and the laser."));
  } else if (!registryHas("zoom_to")) {
    phases.push(
      blockedPhase(
        "zoom",
        `Guide asks for ${zoomStep.zoom}×. zoom_to is not in HARNESS_VIEWER_TOOLS. When that name is registered, a missing or misplaced zoom fails human_sequence.`
      )
    );
  } else {
    phases.push(missedPhase("zoom", "zoom_to is registered and this turn did not zoom."));
  }

  if (!point) {
    phases.push(missedPhase("point", "The laser never hit the marker."));
  } else if (!window || !rankLess(window, point)) {
    phases.push(missedPhase("point", "The laser did not come after the window."));
  } else {
    phases.push(metPhase("point", "After the window."));
  }

  phases.push(
    speechOk
      ? metPhase("speech", "Named this finding only after slice, window, and laser were up.")
      : missedPhase("speech", "Talked about the finding while that viewport was not on screen.")
  );

  return {
    consultant: consultantScript(finding, guide, beat),
    taught: phases.every((phase) => phase.status === "met" || phase.status === "n/a"),
    phases,
  };
}

function consultantScript(finding: Finding, guide: TeachingGuideStep[], beat: TutorEvalBeat): string {
  const slice = guide.find((step) => step.action === "scroll_to")?.sliceIndex ?? finding.sliceIndex;
  const win = guide.find((step) => step.action === "set_window");
  const ww = win?.windowWidth ?? finding.windowWidth;
  const wc = win?.windowCenter ?? finding.windowCenter;
  const zoom = guideZoom(guide);
  const bits = [`scroll to slice ${slice}`, `window ${ww}/${wc}`];
  if (zoom?.zoom != null) bits.push(`zoom ${zoom.zoom}×`);
  bits.push("point at the marker");
  bits.push(`then say ${beat.distinctiveTerms.join(" / ")}`);
  return bits.join(" → ");
}

function metPhase(phase: FidelityPhaseName, detail: string): FidelityPhase {
  return { phase, status: "met", detail };
}

function missedPhase(phase: FidelityPhaseName, detail: string): FidelityPhase {
  return { phase, status: "missed", detail };
}

function blockedPhase(phase: FidelityPhaseName, detail: string): FidelityPhase {
  return { phase, status: "blocked", detail };
}

function naPhase(phase: FidelityPhaseName, detail: string): FidelityPhase {
  return { phase, status: "n/a", detail };
}

function pointerBeforeWindow(before: SimViewer, finding: Finding, effects: ViewerEffect[]): HardCheck {
  const ww = finding.windowWidth;
  const wc = finding.windowCenter;
  if (ww == null || wc == null) {
    return pass("pointer_before_window", "Finding has no authored VOI to compare.");
  }
  if (voiMatches(before.windowWidth, before.windowCenter, ww, wc)) {
    return pass("pointer_before_window", "Window was already the authored VOI before this turn.");
  }
  const points = effects.filter((effect) => effect.type === "point");
  if (points.length === 0) {
    return pass(
      "pointer_before_window",
      "No laser was drawn. The miss is landing_pointer, not a laser on the wrong window."
    );
  }
  const correctWindow = earliest(
    effects.filter(
      (effect) => effect.type === "window" && voiMatches(effect.windowWidth, effect.windowCenter, ww, wc)
    )
  );
  const firstPoint = earliest(points);
  if (!correctWindow || (firstPoint && rankLess(firstPoint, correctWindow))) {
    return fail(
      "pointer_before_window",
      "The laser moved while the window was still wrong. Set the window before the laser — a pleural line on soft-tissue windows is not teaching."
    );
  }
  return pass("pointer_before_window", "The laser landed with or after the authored window, not before it.");
}

function orderCheck(guide: TeachingGuideStep[], finding: Finding, effects: ViewerEffect[]): HardCheck {
  const gating = guide.filter(guideStepIsGating);
  const ranks: { action: TeachingGuideAction; rank: Rank }[] = [];
  const missing: string[] = [];
  for (const step of gating) {
    const rank = satisfierRank(step, finding, effects);
    if (!rank) missing.push(step.action);
    else ranks.push({ action: step.action, rank });
  }
  if (missing.length > 0) {
    return fail(
      "order",
      `Guide steps never happened: ${missing.join(", ")}. Expected ${gating
        .map((step) => step.action)
        .join(" → ")}.`
    );
  }
  for (let i = 0; i < ranks.length - 1; i++) {
    const earlier = ranks[i];
    const later = ranks[i + 1];
    if (rankLess(later.rank, earlier.rank)) {
      return fail(
        "order",
        `${later.action} landed before ${earlier.action}. Teacher order is ${gating
          .map((step) => step.action)
          .join(" → ")}. Pointing at the wrong window, or scrolling after you have already lectured the wrong slice, fails.`
      );
    }
  }
  return pass(
    "order",
    `Effect order respects ${gating.map((step) => step.action).join(" → ")}. Equal ranks may tie. A show_finding is scroll, then window, then laser.`
  );
}

function satisfierRank(
  step: TeachingGuideStep,
  finding: Finding,
  effects: ViewerEffect[]
): Rank | null {
  switch (step.action) {
    case "set_window": {
      const ww = step.windowWidth ?? finding.windowWidth;
      const wc = step.windowCenter ?? finding.windowCenter;
      if (ww == null || wc == null) return null;
      return earliest(
        effects.filter(
          (effect) => effect.type === "window" && voiMatches(effect.windowWidth, effect.windowCenter, ww, wc)
        )
      );
    }
    case "scroll_to": {
      const slice = step.sliceIndex ?? finding.sliceIndex;
      return earliest(
        effects.filter((effect) => effect.type === "scroll" && effect.sliceIndex === slice)
      );
    }
    case "zoom_to": {
      const target = step.zoom;
      return earliest(
        effects.filter((effect) => {
          if (effect.type !== "zoom" || effect.zoom == null || !Number.isFinite(effect.zoom)) return false;
          if (target == null || !Number.isFinite(target)) return true;
          return Math.abs(effect.zoom - target) <= ZOOM_TOLERANCE;
        })
      );
    }
    case "point_to":
      return earliest(effects.filter((effect) => effect.type === "point" && pointHits(effect, finding)));
    case "show_finding":
    case "next_in_tour":
    case "prev_in_tour": {
      const slice = finding.sliceIndex;
      const scrolled = effects.filter(
        (effect) => effect.type === "scroll" && effect.sliceIndex === slice
      );
      return earliest(scrolled);
    }
    default:
      return null;
  }
}

function craftHoles(guide: TeachingGuideStep[], finding: Finding, effects: ViewerEffect[]): string[] {
  const holes: string[] = [];
  for (const step of guide) {
    if (guideStepIsGating(step)) continue;
    if (step.action === "zoom_to" && effects.some((effect) => effect.type === "zoom")) continue;
    const zoom = step.zoom != null ? `${step.zoom}×` : "in";
    holes.push(
      `${step.action} at t=${step.t}ms is on the teaching guide and not in HARNESS_VIEWER_TOOLS. ` +
        (step.action === "zoom_to"
          ? `Teacher zoomed ${zoom} on ${finding.label}. This turn did not zoom. Not a free pass — a hole. When zoom_to joins the registry this becomes a hard fail.`
          : "The turn did not produce it.")
    );
  }
  if (!guide.some((step) => step.action === "zoom_to")) {
    const camera = finding.track?.events.find((event) => event.type === "camera");
    if (camera && camera.type === "camera" && !effects.some((effect) => effect.type === "zoom")) {
      holes.push(
        `Track zooms to ${camera.zoom}× on ${finding.label} and the guide forgot zoom_to. Still a hole: the tutor never zoomed.`
      );
    }
  }
  return holes;
}

function pointHits(effect: ViewerEffect, finding: Finding): boolean {
  if (effect.x_pct == null || effect.y_pct == null) return false;
  return clickHitsFinding(finding.marker, effect.x_pct, effect.y_pct);
}

function earliest(effects: ViewerEffect[]): Rank | null {
  if (effects.length === 0) return null;
  return effects.reduce<Rank>(
    (best, effect) => (rankLess(effect, best) ? { seq: effect.seq, sub: effect.sub } : best),
    { seq: effects[0].seq, sub: effects[0].sub }
  );
}

function rankLess(a: Rank, b: Rank): boolean {
  return a.seq < b.seq || (a.seq === b.seq && a.sub < b.sub);
}

export function applyActions(
  start: SimViewer,
  actions: EvalAction[],
  findings: Finding[]
): { viewer: SimViewer; effects: ViewerEffect[]; seated: string[] } {
  const viewer = cloneViewer(start);
  const effects: ViewerEffect[] = [];
  const seated: string[] = [];
  const ordered = findings.slice().sort((a, b) => a.order - b.order);

  actions.forEach((action, seq) => {
    if (action.type === "none") return;
    if (action.type === "show_finding") {
      const finding = ordered.find((item) => item.id === action.findingId);
      if (finding) reveal(viewer, finding, seq, "show_finding", effects, seated);
      return;
    }
    if (action.type === "next_in_tour" || action.type === "prev_in_tour") {
      const current = ordered.findIndex((item) => item.id === viewer.activeFindingId);
      const nextIndex =
        action.type === "next_in_tour"
          ? Math.min((current < 0 ? -1 : current) + 1, ordered.length - 1)
          : Math.max((current < 0 ? 1 : current) - 1, 0);
      const finding = ordered[nextIndex];
      if (finding) reveal(viewer, finding, seq, action.type, effects, seated);
      return;
    }
    if (action.type === "set_window") {
      if (!Number.isFinite(action.windowWidth) || !Number.isFinite(action.windowCenter)) return;
      viewer.windowWidth = action.windowWidth;
      viewer.windowCenter = action.windowCenter;
      effects.push({
        type: "window",
        seq,
        sub: 0,
        source: "set_window",
        windowWidth: action.windowWidth,
        windowCenter: action.windowCenter,
        findingId: viewer.activeFindingId ?? undefined,
      });
      return;
    }
    if (action.type === "point_to") {
      if (action.findingId) {
        const finding = ordered.find((item) => item.id === action.findingId);
        if (finding && finding.id !== viewer.activeFindingId) {
          // Client: pointing at a finding you are not on reveals it (slice, window, then laser).
          reveal(viewer, finding, seq, "point_to", effects, seated);
          return;
        }
        if (finding?.marker) {
          putPoint(viewer, effects, seq, 0, "point_to", finding.marker.x_pct, finding.marker.y_pct, finding.id);
          return;
        }
      }
      if (action.x_pct != null && action.y_pct != null && Number.isFinite(action.x_pct) && Number.isFinite(action.y_pct)) {
        putPoint(viewer, effects, seq, 0, "point_to", action.x_pct, action.y_pct, viewer.activeFindingId ?? undefined);
      }
      return;
    }
    if (action.type === "scroll_to") {
      if (!Number.isFinite(action.sliceIndex)) return;
      viewer.sliceIndex = action.sliceIndex;
      effects.push({
        type: "scroll",
        seq,
        sub: 0,
        source: "scroll_to",
        sliceIndex: action.sliceIndex,
        findingId: viewer.activeFindingId ?? undefined,
      });
      return;
    }
    if (action.type === "zoom_to" || action.type === "set_zoom") {
      if (!Number.isFinite(action.zoom)) return;
      viewer.zoom = action.zoom;
      effects.push({
        type: "zoom",
        seq,
        sub: 0,
        source: action.type,
        zoom: action.zoom,
        findingId: viewer.activeFindingId ?? undefined,
      });
    }
  });

  return { viewer, effects, seated };
}

function reveal(
  viewer: SimViewer,
  finding: Finding,
  seq: number,
  source: string,
  effects: ViewerEffect[],
  seated: string[]
): void {
  if (finding.seriesInstanceUID && finding.seriesInstanceUID !== viewer.seriesInstanceUID) {
    viewer.seriesInstanceUID = finding.seriesInstanceUID;
    effects.push({
      type: "series",
      seq,
      sub: 0,
      source,
      findingId: finding.id,
      seriesInstanceUID: finding.seriesInstanceUID,
    });
  }
  if (finding.sliceIndex != null && Number.isFinite(finding.sliceIndex)) {
    viewer.sliceIndex = finding.sliceIndex;
    effects.push({
      type: "scroll",
      seq,
      sub: 0,
      source,
      findingId: finding.id,
      sliceIndex: finding.sliceIndex,
    });
  }
  if (
    finding.windowWidth != null &&
    finding.windowCenter != null &&
    Number.isFinite(finding.windowWidth) &&
    Number.isFinite(finding.windowCenter)
  ) {
    viewer.windowWidth = finding.windowWidth;
    viewer.windowCenter = finding.windowCenter;
    effects.push({
      type: "window",
      seq,
      sub: 1,
      source,
      findingId: finding.id,
      windowWidth: finding.windowWidth,
      windowCenter: finding.windowCenter,
    });
  }
  if (markerOk(finding.marker?.x_pct, finding.marker?.y_pct)) {
    putPoint(viewer, effects, seq, 2, source, finding.marker.x_pct, finding.marker.y_pct, finding.id);
  }
  viewer.activeFindingId = finding.id;
  seated.push(finding.id);
}

function putPoint(
  viewer: SimViewer,
  effects: ViewerEffect[],
  seq: number,
  sub: number,
  source: string,
  x: number,
  y: number,
  findingId?: string
): void {
  viewer.pointer = { x, y };
  effects.push({
    type: "point",
    seq,
    sub,
    source,
    findingId,
    x_pct: x,
    y_pct: y,
  });
}

function formatDrive(effects: ViewerEffect[]): string {
  if (effects.length === 0) return "(viewer never moved)";
  return effects
    .map((effect) => {
      switch (effect.type) {
        case "scroll":
          return `scroll slice ${effect.sliceIndex}`;
        case "window":
          return `window ${effect.windowWidth}/${effect.windowCenter}`;
        case "point":
          return `point (${effect.x_pct?.toFixed(2)}, ${effect.y_pct?.toFixed(2)})`;
        case "zoom":
          return `zoom ${effect.zoom}×`;
        case "series":
          return `series ${effect.seriesInstanceUID}`;
        default:
          return effect.type;
      }
    })
    .join(" → ");
}

export function formatScorecard(score: SessionScore): string {
  const verdict = score.hardPass ? "PASS" : "FAIL";
  const bar = score.hardPass
    ? "drove the viewer — this is not a chatbot"
    : "FAILS THE BAR — chatbot with a picture, or a drive that does not match the finding";
  const world = score.worldClass
    ? "YES"
    : score.hardPass
      ? "NO. Craft holes below. A pass here is not a world-class teacher."
      : "NO";
  const lines: string[] = [
    "FLOWRAD TUTOR EVAL",
    `fixture    ${score.fixtureId}`,
    `tutor      ${score.tutorName}`,
    `VERDICT    ${verdict}`,
    `bar        ${bar}`,
    `hard       ${score.hardPassed}/${score.hardTotal} checks    score ${score.hardScore}/100`,
    `world      ${world}`,
    "",
  ];
  for (const beat of score.beats) {
    const failed = beat.checks.filter((check) => !check.pass).length;
    lines.push(
      `── ${beat.beatId}  ${beat.findingId}  ${beat.label}  (${failed === 0 ? "clean" : `${failed} failed`})`
    );
    lines.push(`   tools   ${beat.tools.length ? beat.tools.join(", ") : "(none)"}`);
    lines.push(`   drive   ${beat.drive}`);
    for (const check of beat.checks) {
      lines.push(`   ${check.pass ? "PASS" : "FAIL"}  ${check.id.padEnd(22)} ${check.detail}`);
    }
    for (const hole of beat.holes) {
      lines.push(`   HOLE  ${hole}`);
    }
    lines.push("");
  }
  if (score.holes.length === 0) {
    lines.push("HOLES      none");
  } else {
    lines.push("HOLES");
    for (const hole of score.holes) lines.push(`  - ${hole}`);
  }
  lines.push("");
  lines.push(formatFidelity(score));
  return lines.join("\n");
}

function formatFidelity(score: SessionScore): string {
  const lines = [
    "HUMAN-TEACHER FIDELITY",
    "  question   Would a registrar feel taught at the workstation?",
    `  answer     ${fidelityVerdict(score)}`,
    `  phases     ${score.fidelityMet}/${score.fidelityRequired} met`,
    "",
  ];
  for (const beat of score.beats) {
    lines.push(
      `  ${beat.fidelity.taught ? "TAUGHT    " : "NOT TAUGHT"}  ${beat.beatId}  ${beat.label}`
    );
    lines.push(`             consultant  ${beat.fidelity.consultant}`);
    for (const phase of beat.fidelity.phases) {
      const tag =
        phase.status === "met"
          ? "MET"
          : phase.status === "missed"
            ? "MISSED"
            : phase.status === "blocked"
              ? "BLOCKED"
              : "n/a";
      lines.push(`             ${phase.phase.padEnd(8)} ${tag.padEnd(7)} ${phase.detail}`);
    }
    lines.push("");
  }
  lines.push("  failure modes a consultant does not commit");
  lines.push("    frozen image     names the finding while slice and window never change. Text-only scores 0.");
  lines.push("    random scroll    the path walks away from the target slice, or onto the other finding.");
  lines.push("    early lecture    says the finding before slice, window, and laser are already up.");
  lines.push("    zoom             zooms after the laser, or skips zoom once zoom_to is a real tool.");
  return lines.join("\n");
}

function fidelityVerdict(score: SessionScore): string {
  if (score.fidelityTaught) {
    return "YES. Scroll, window, zoom when the teacher zoomed, point, then the words — on the image in front of them.";
  }
  if (score.hardPass) {
    return "NO. Tools moved the scan, and this is still not a world-class teacher. A blocked zoom means the registrar never saw the teacher's magnification.";
  }
  return "NO. Lectured next to the wrong image, or the sequence was not how a consultant teaches this case.";
}

export function formatContract(textOnly: SessionScore, driver: SessionScore): string {
  const held = harnessContractHeld(textOnly, driver);
  return [
    "HARNESS CONTRACT",
    `  text-only fake      ${textOnly.hardPass ? "PASS (this is a bug in the rubric)" : "FAIL (required)"}    score ${textOnly.hardScore}/100`,
    `  viewer-driving      ${driver.hardPass ? "PASS (required)" : "FAIL (this is a bug in the rubric)"}    score ${driver.hardScore}/100    fidelity ${driver.fidelityTaught ? "TAUGHT" : "NOT TAUGHT"}`,
    `  CONTRACT            ${held ? "HELD" : "BROKEN"}`,
  ].join("\n");
}

function laterDistinctiveTerms(fixture: TutorEvalFixture, finding: Finding): string[] {
  const laterIds = new Set(
    fixture.case.findings.filter((item) => item.order > finding.order).map((item) => item.id)
  );
  const terms: string[] = [];
  for (const beat of fixture.beats) {
    if (!laterIds.has(beat.findingId)) continue;
    terms.push(...beat.distinctiveTerms);
  }
  return terms;
}

function leakedInternals(text: string, findingIds: string[]): string | null {
  for (const id of findingIds) {
    if (id && text.includes(id)) return `finding id ${id}`;
  }
  const coord = /\b0\.\d{2,}\b/.exec(text);
  if (coord) return `coordinate ${coord[0]}`;
  if (/\b(sliceIndex|windowWidth|windowCenter|findingId)\b/.test(text)) return "field name";
  return null;
}

function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\w*`, "i").test(text);
}

function markerOk(x: number | undefined, y: number | undefined): boolean {
  return (
    x != null &&
    y != null &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1
  );
}

function findingById(fixture: TutorEvalFixture, id: string): Finding {
  const finding = fixture.case.findings.find((item) => item.id === id);
  if (!finding) throw new Error(`Unknown finding ${id}.`);
  return finding;
}

function cloneViewer(viewer: SimViewer): SimViewer {
  return {
    ...viewer,
    pointer: viewer.pointer ? { ...viewer.pointer } : null,
  };
}

function pass(id: string, detail: string): HardCheck {
  return { id, pass: true, detail };
}

function fail(id: string, detail: string): HardCheck {
  return { id, pass: false, detail };
}
