import { test } from "node:test";
import assert from "node:assert/strict";

import type { TutorAgent, TutorTurn } from "./tutorEval.ts";
import {
  formatContract,
  formatScorecard,
  harnessContractHeld,
  humanTeachActions,
  loadTutorFixture,
  parseTutorFixture,
  resolveTeachingGuide,
  scoreTutorSession,
  teachingGuideFromTrack,
  textOnlyTutor,
  viewerDrivingTutor,
} from "./tutorEval.ts";

const fixture = loadTutorFixture();

function check(score: Awaited<ReturnType<typeof scoreTutorSession>>, beatId: string, id: string) {
  const beat = score.beats.find((item) => item.beatId === beatId);
  const found = beat?.checks.find((item) => item.id === id);
  assert.ok(found, `missing check ${beatId}/${id}`);
  return found;
}

test("fixture is a synthetic two-finding teach script with no PHI", () => {
  assert.equal(fixture.phi, "none");
  assert.equal(fixture.case.findings.length, 2);
  assert.equal(fixture.beats.length, 2);
  assert.equal(fixture.initialViewer.sliceIndex, 0);
  assert.equal(fixture.initialViewer.windowWidth, 400);
  assert.notEqual(fixture.case.findings[0].sliceIndex, 0);
  assert.ok(fixture.case.findings[1].track?.events.some((event) => event.type === "camera"));
});

test("text-only tutor scores 0 even when the pneumothorax paragraph is right", async () => {
  const score = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(score.worldClass, false);
  assert.equal(check(score, "beat-ptx", "text_only").pass, false);
  assert.equal(check(score, "beat-ptx", "narration_on_screen").pass, true);
  assert.equal(check(score, "beat-ptx", "look_cue").pass, true);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_window").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_pointer").pass, false);
  assert.equal(check(score, "beat-ptx", "look_with_drive").pass, false);
  assert.equal(check(score, "beat-ptx", "speech_on_viewport").pass, false);
  assert.equal(check(score, "beat-ptx", "human_sequence").pass, false);
  assert.equal(score.fidelityTaught, false);
  const card = formatScorecard(score);
  assert.match(card, /VERDICT\s+FAIL/);
  assert.match(card, /text_only/);
  assert.match(card, /viewer never moved/);
  assert.match(card, /HUMAN-TEACHER FIDELITY/);
  assert.match(card, /frozen image/);
});

test("viewer-driving tutor is the consultant sequence, including zoom", async () => {
  const score = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  assert.equal(score.hardPass, true);
  assert.equal(score.hardScore, 100);
  assert.equal(score.fidelityTaught, true);
  assert.equal(score.worldClass, true);
  assert.deepEqual(score.holes, []);
  assert.equal(check(score, "beat-ptx", "order").pass, true);
  assert.equal(check(score, "beat-ptx", "human_sequence").pass, true);
  assert.equal(check(score, "beat-ptx", "speech_on_viewport").pass, true);
  assert.equal(check(score, "beat-ptx", "pointer_before_window").pass, true);
  assert.equal(check(score, "beat-nodule", "landing_slice").pass, true);
  assert.equal(check(score, "beat-nodule", "human_sequence").pass, true);
  assert.equal(check(score, "beat-nodule", "speech_on_viewport").pass, true);
  assert.equal(check(score, "beat-nodule", "narration_on_screen").pass, true);
  assert.equal(check(score, "beat-nodule", "narration_ahead").pass, true);
  assert.deepEqual(score.beats[1].tools, ["scroll_to", "set_window", "zoom_to", "point_to"]);
  const noduleZoom = score.beats[1].fidelity.phases.find((phase) => phase.phase === "zoom");
  assert.equal(noduleZoom?.status, "met");
  const ptxZoom = score.beats[0].fidelity.phases.find((phase) => phase.phase === "zoom");
  assert.equal(ptxZoom?.status, "n/a");
  const card = formatScorecard(score);
  assert.match(card, /VERDICT\s+PASS/);
  assert.match(card, /world\s+YES/);
  assert.match(card, /HUMAN-TEACHER FIDELITY/);
  assert.match(card, /TAUGHT/);
  assert.doesNotMatch(card, /BLOCKED/);
  assert.match(score.beats[1].drive, /zoom 2\.2/);
});

test("harness contract: chatbot fails, driver passes", async () => {
  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  const driver = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  assert.equal(harnessContractHeld(textOnly, driver), true);
  const contract = formatContract(textOnly, driver);
  assert.match(contract, /CONTRACT\s+HELD/);
  assert.match(contract, /text-only fake\s+FAIL/);
  assert.match(contract, /viewer-driving\s+PASS/);
  assert.match(contract, /fidelity TAUGHT/);
});

test("show_finding alone seats the pneumothorax and fails the nodule zoom", async () => {
  const showOnly: TutorAgent = (ctx) => ({
    answer: ctx.beat.drivingNarration,
    actions: [{ type: "show_finding", findingId: ctx.finding.id }],
  });
  const score = await scoreTutorSession(fixture, showOnly, "show_finding only");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(score.worldClass, false);
  assert.equal(check(score, "beat-ptx", "human_sequence").pass, true);
  assert.equal(check(score, "beat-ptx", "pointer_before_window").pass, true);
  assert.equal(check(score, "beat-nodule", "human_sequence").pass, false);
  assert.equal(check(score, "beat-nodule", "order").pass, false);
  assert.match(check(score, "beat-nodule", "order").detail, /zoom_to/);
  const zoom = score.beats[1].fidelity.phases.find((phase) => phase.phase === "zoom");
  assert.equal(zoom?.status, "missed");
  assert.match(score.beats[0].drive, /scroll slice 8/);
  assert.match(score.beats[0].drive, /window 1500\/-600/);
  assert.match(score.beats[1].drive, /scroll slice 27/);
});

test("pointing before the window fails, even if a later show_finding repairs the landing", async () => {
  const premature: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-ptx") return viewerDrivingTutor(ctx);
    const turn: TutorTurn = {
      answer: ctx.beat.drivingNarration,
      actions: [
        { type: "point_to", x_pct: 0.28, y_pct: 0.22 },
        { type: "set_window", windowWidth: 1500, windowCenter: -600 },
        { type: "show_finding", findingId: "f_ptx" },
      ],
    };
    return turn;
  };
  const score = await scoreTutorSession(fixture, premature, "laser first");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(check(score, "beat-ptx", "pointer_before_window").pass, false);
  assert.equal(check(score, "beat-ptx", "order").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, true);
});

test("showing the other finding fails the seat", async () => {
  const wrong: TutorAgent = (ctx) => ({
    answer: ctx.beat.drivingNarration,
    actions: [
      {
        type: "show_finding",
        findingId: ctx.beat.id === "beat-ptx" ? "f_nodule" : "f_ptx",
      },
    ],
  });
  const score = await scoreTutorSession(fixture, wrong, "wrong finding");
  assert.equal(check(score, "beat-ptx", "seated_finding").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, false);
  assert.equal(score.hardPass, false);
});

test("an invented window fails even when show_finding then corrects it", async () => {
  const invented: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-ptx") return viewerDrivingTutor(ctx);
    return {
      answer: ctx.beat.drivingNarration,
      actions: [
        { type: "set_window", windowWidth: 80, windowCenter: 40 },
        { type: "show_finding", findingId: "f_ptx" },
      ],
    };
  };
  const score = await scoreTutorSession(fixture, invented, "brain window");
  assert.equal(check(score, "beat-ptx", "hallucinated_window").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_window").pass, true);
  assert.equal(score.hardPass, false);
});

test("naming the later nodule while teaching the pneumothorax fails", async () => {
  const spoil: TutorAgent = (ctx) => ({
    answer:
      ctx.beat.id === "beat-ptx"
        ? "Look at this slice. The pneumothorax is the pleural line, and there is also a nodule lower down."
        : ctx.beat.drivingNarration,
    actions: viewerDrivingTutor(ctx).actions,
  });
  const score = await scoreTutorSession(fixture, spoil, "spoiler");
  assert.equal(check(score, "beat-ptx", "narration_ahead").pass, false);
  assert.equal(check(score, "beat-ptx", "text_only").pass, true);
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
});

test("speaking a finding id fails hygiene", async () => {
  const leak: TutorAgent = (ctx) => ({
    answer: `Look at this slice. Finding f_ptx is a pneumothorax along the pleural line.`,
    actions: viewerDrivingTutor(ctx).actions,
  });
  const score = await scoreTutorSession(fixture, leak, "leaky");
  assert.equal(check(score, "beat-ptx", "narration_hygiene").pass, false);
  assert.equal(score.hardPass, false);
});

test("next_in_tour seats the nodule and still fails because it never zooms", async () => {
  const tour: TutorAgent = (ctx) =>
    ctx.beat.id === "beat-ptx"
      ? { answer: ctx.beat.drivingNarration, actions: [{ type: "show_finding", findingId: "f_ptx" }] }
      : { answer: ctx.beat.drivingNarration, actions: [{ type: "next_in_tour" }] };
  const score = await scoreTutorSession(fixture, tour, "tour");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(check(score, "beat-nodule", "seated_finding").pass, true);
  assert.equal(check(score, "beat-nodule", "landing_pointer").pass, true);
  assert.equal(check(score, "beat-nodule", "human_sequence").pass, false);
});

test("scroll, window, zoom, then point teaches the nodule and clears the hole", async () => {
  const zooming: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-nodule") return viewerDrivingTutor(ctx);
    return {
      answer: ctx.beat.drivingNarration,
      actions: humanTeachActions(ctx.finding, resolveTeachingGuide(ctx.beat, ctx.finding)),
    };
  };
  const score = await scoreTutorSession(fixture, zooming, "consultant sequence");
  assert.equal(score.hardPass, true);
  assert.equal(score.hardScore, 100);
  assert.equal(score.fidelityTaught, true);
  assert.equal(score.worldClass, true);
  assert.deepEqual(score.holes, []);
  assert.equal(check(score, "beat-nodule", "human_sequence").pass, true);
  assert.equal(check(score, "beat-nodule", "speech_on_viewport").pass, true);
  assert.equal(check(score, "beat-nodule", "no_random_jump").pass, true);
  const zoom = score.beats[1].fidelity.phases.find((phase) => phase.phase === "zoom");
  assert.equal(zoom?.status, "met");
  assert.match(score.beats[1].drive, /zoom 2\.2/);
  assert.match(formatScorecard(score), /TAUGHT/);
});

test("set_zoom counts as the same lean-in as zoom_to", async () => {
  const alias: TutorAgent = (ctx) => {
    const turn = viewerDrivingTutor(ctx);
    turn.actions = turn.actions.map((action) =>
      action.type === "zoom_to" ? { type: "set_zoom", zoom: action.zoom } : action
    );
    return turn;
  };
  const score = await scoreTutorSession(fixture, alias, "set_zoom alias");
  assert.equal(score.hardPass, true);
  assert.equal(score.worldClass, true);
  assert.equal(score.fidelityTaught, true);
  assert.match(score.beats[1].drive, /zoom 2\.2/);
});

test("zoom after the laser fails the human sequence", async () => {
  const late: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-nodule") return viewerDrivingTutor(ctx);
    return {
      answer: ctx.beat.drivingNarration,
      actions: [
        { type: "show_finding", findingId: "f_nodule" },
        { type: "zoom_to", zoom: 2.2 },
      ],
    };
  };
  const score = await scoreTutorSession(fixture, late, "zoom after laser");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(score.worldClass, false);
  assert.equal(score.fidelityTaught, false);
  assert.equal(check(score, "beat-nodule", "human_sequence").pass, false);
  const zoom = score.beats[1].fidelity.phases.find((phase) => phase.phase === "zoom");
  assert.equal(zoom?.status, "missed");
  assert.deepEqual(score.holes, []);
});

test("a scroll that walks away from the slice fails even when the landing is repaired", async () => {
  const jumpy: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-ptx") return viewerDrivingTutor(ctx);
    const turn: TutorTurn = {
      answer:
        "Look. Still scrolling. Now. That is a right apical pneumothorax along the pleural line.",
      actions: [
        { type: "scroll_to", sliceIndex: 3 },
        { type: "scroll_to", sliceIndex: 39 },
        { type: "show_finding", findingId: "f_ptx" },
      ],
    };
    return turn;
  };
  const score = await scoreTutorSession(fixture, jumpy, "random jump");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(check(score, "beat-ptx", "no_random_jump").pass, false);
  assert.match(check(score, "beat-ptx", "no_random_jump").detail, /39/);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, true);
  assert.equal(check(score, "beat-ptx", "speech_on_viewport").pass, true);
});

test("naming the finding in the same sentence as the drive fails speech_on_viewport", async () => {
  const early: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-ptx") return viewerDrivingTutor(ctx);
    return {
      answer: "Look at this pleural line — right apical pneumothorax. Report the line.",
      actions: [{ type: "show_finding", findingId: "f_ptx" }],
    };
  };
  const score = await scoreTutorSession(fixture, early, "early lecture");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(check(score, "beat-ptx", "speech_on_viewport").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, true);
  assert.equal(check(score, "beat-ptx", "landing_window").pass, true);
  assert.equal(check(score, "beat-ptx", "narration_on_screen").pass, true);
  assert.equal(score.beats[0].fidelity.taught, false);
});

test("setting the window before the scroll fails the human sequence", async () => {
  const windowFirst: TutorAgent = (ctx) => {
    if (ctx.beat.id !== "beat-ptx") return viewerDrivingTutor(ctx);
    const turn: TutorTurn = {
      answer: "Look. Window. The pleural line is a pneumothorax.",
      actions: [
        { type: "set_window", windowWidth: 1500, windowCenter: -600 },
        { type: "show_finding", findingId: "f_ptx" },
      ],
    };
    return turn;
  };
  const score = await scoreTutorSession(fixture, windowFirst, "window before scroll");
  assert.equal(score.hardPass, false);
  assert.equal(score.hardScore, 0);
  assert.equal(check(score, "beat-ptx", "human_sequence").pass, false);
  assert.equal(check(score, "beat-ptx", "order").pass, false);
  assert.equal(check(score, "beat-ptx", "landing_slice").pass, true);
  assert.equal(check(score, "beat-ptx", "speech_on_viewport").pass, true);
});

test("teachingGuideFromTrack is scroll, window, zoom, then point", () => {
  const nodule = fixture.case.findings.find((finding) => finding.id === "f_nodule");
  assert.ok(nodule);
  const guide = teachingGuideFromTrack(nodule);
  assert.deepEqual(
    guide.map((step) => step.action),
    ["scroll_to", "set_window", "zoom_to", "point_to"]
  );
  assert.equal(guide.find((step) => step.action === "zoom_to")?.zoom, 2.2);
  assert.equal(guide.find((step) => step.action === "scroll_to")?.sliceIndex, 27);
  for (let i = 1; i < guide.length; i++) {
    assert.ok(guide[i].t > guide[i - 1].t);
  }
  const actions = humanTeachActions(nodule, guide);
  assert.deepEqual(
    actions.map((action) => action.type),
    ["scroll_to", "set_window", "zoom_to", "point_to"]
  );
});

test("a silent tool is not a tour, and a blank play_guide is", async () => {
  const silent: TutorAgent = (ctx) => ({
    answer: "",
    actions: [{ type: "show_finding", findingId: ctx.finding.id }],
  });
  const organized: TutorAgent = (ctx) => ({
    answer: "",
    actions: [{ type: "play_guide", findingId: ctx.finding.id }],
  });
  const silentScore = await scoreTutorSession(fixture, silent, "silent show_finding");
  const organizedScore = await scoreTutorSession(fixture, organized, "organized play_guide");
  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");

  assert.equal(check(silentScore, "beat-ptx", "spoken_beat").pass, false);
  assert.equal(check(silentScore, "beat-ptx", "narration_present").pass, false);
  assert.equal(silentScore.hardPass, false);

  assert.equal(check(textOnly, "beat-ptx", "text_only").pass, false);
  assert.equal(check(textOnly, "beat-ptx", "spoken_beat").pass, true);
  assert.equal(textOnly.hardPass, false);

  assert.equal(organizedScore.hardPass, true, formatScorecard(organizedScore));
  assert.equal(organizedScore.worldClass, true);
  assert.equal(check(organizedScore, "beat-ptx", "spoken_beat").pass, true);
  assert.equal(check(organizedScore, "beat-ptx", "speech_on_viewport").pass, true);
  assert.equal(check(organizedScore, "beat-ptx", "narration_ahead").pass, true);
  assert.equal(check(organizedScore, "beat-nodule", "human_sequence").pass, true);
  assert.ok(organizedScore.hardPassed > silentScore.hardPassed);
});

test("loader rejects identifiers and a viewer that is already on the finding", () => {
  assert.throws(() => parseTutorFixture({ ...fixture, notes: "PatientName: example" }), /patient/i);
  const seated = structuredClone(fixture);
  seated.initialViewer = {
    ...seated.initialViewer,
    sliceIndex: 8,
    windowWidth: 1500,
    windowCenter: -600,
  };
  assert.throws(() => parseTutorFixture(seated), /already shows/);
});
