import { test } from "node:test";
import assert from "node:assert/strict";

import type { TutorAgent, TutorTurn } from "./tutorEval.ts";
import {
  formatContract,
  formatScorecard,
  harnessContractHeld,
  loadTutorFixture,
  parseTutorFixture,
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
  assert.match(formatScorecard(score), /VERDICT\s+FAIL/);
  assert.match(formatScorecard(score), /text_only/);
  assert.match(formatScorecard(score), /viewer never moved/);
});

test("viewer-driving tutor zooms the nodule and clears the craft hole", async () => {
  const score = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  assert.equal(score.hardPass, true);
  assert.equal(score.hardScore, 100);
  assert.equal(score.worldClass, true);
  assert.equal(check(score, "beat-ptx", "order").pass, true);
  assert.equal(check(score, "beat-ptx", "pointer_before_window").pass, true);
  assert.equal(check(score, "beat-nodule", "order").pass, true);
  assert.equal(check(score, "beat-nodule", "landing_slice").pass, true);
  assert.equal(check(score, "beat-nodule", "narration_on_screen").pass, true);
  assert.equal(check(score, "beat-nodule", "narration_ahead").pass, true);
  assert.deepEqual(score.holes, []);
  const card = formatScorecard(score);
  assert.match(card, /VERDICT\s+PASS/);
  assert.match(card, /zoom 2\.2/);
  assert.match(card, /world\s+YES/);
});

test("harness contract: chatbot fails, driver passes", async () => {
  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  const driver = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  assert.equal(harnessContractHeld(textOnly, driver), true);
  const contract = formatContract(textOnly, driver);
  assert.match(contract, /CONTRACT\s+HELD/);
  assert.match(contract, /text-only fake\s+FAIL/);
  assert.match(contract, /viewer-driving\s+PASS/);
});

test("show_finding alone seats the pneumothorax and fails the nodule zoom", async () => {
  const showOnly: TutorAgent = (ctx) => ({
    answer: ctx.beat.drivingNarration,
    actions: [{ type: "show_finding", findingId: ctx.finding.id }],
  });
  const score = await scoreTutorSession(fixture, showOnly, "show_finding only");
  assert.equal(check(score, "beat-ptx", "pointer_before_window").pass, true);
  assert.equal(check(score, "beat-ptx", "order").pass, true);
  assert.match(score.beats[0].drive, /scroll slice 8/);
  assert.match(score.beats[0].drive, /window 1500\/-600/);
  assert.match(score.beats[1].drive, /scroll slice 27/);
  assert.equal(check(score, "beat-nodule", "order").pass, false);
  assert.match(check(score, "beat-nodule", "order").detail, /zoom_to/);
  assert.equal(score.hardPass, false);
  assert.equal(score.worldClass, false);
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

test("next_in_tour seats the second finding; zoom_to then makes the nodule step pass", async () => {
  const tour: TutorAgent = (ctx) =>
    ctx.beat.id === "beat-ptx"
      ? { answer: ctx.beat.drivingNarration, actions: [{ type: "show_finding", findingId: "f_ptx" }] }
      : {
          answer: ctx.beat.drivingNarration,
          actions: [
            { type: "next_in_tour" },
            { type: "zoom_to", zoom: 2.2 },
            { type: "point_to", findingId: "f_nodule" },
          ],
        };
  const score = await scoreTutorSession(fixture, tour, "tour");
  assert.equal(score.hardPass, true);
  assert.equal(score.worldClass, true);
  assert.equal(check(score, "beat-nodule", "seated_finding").pass, true);
  assert.equal(check(score, "beat-nodule", "landing_pointer").pass, true);
  assert.equal(check(score, "beat-nodule", "order").pass, true);
  assert.match(score.beats[1].drive, /zoom 2\.2/);
});

test("emitting zoom_to clears the craft hole and can be world-class", async () => {
  const zooming: TutorAgent = (ctx) => {
    const turn = viewerDrivingTutor(ctx);
    if (ctx.beat.id === "beat-nodule") turn.actions.push({ type: "zoom_to", zoom: 2.2 });
    return turn;
  };
  const score = await scoreTutorSession(fixture, zooming, "zoom capable");
  assert.equal(score.hardPass, true);
  assert.equal(score.worldClass, true);
  assert.deepEqual(score.holes, []);
  assert.match(score.beats[1].drive, /zoom 2\.2/);
});

test("teachingGuideFromTrack keeps the teacher's zoom as a future action", () => {
  const nodule = fixture.case.findings.find((finding) => finding.id === "f_nodule");
  assert.ok(nodule);
  const guide = teachingGuideFromTrack(nodule);
  assert.ok(guide.some((step) => step.action === "zoom_to" && step.zoom === 2.2));
  assert.ok(guide.some((step) => step.action === "scroll_to" && step.sliceIndex === 27));
  assert.ok(guide.some((step) => step.action === "point_to"));
  assert.equal(guide[guide.length - 1].action, "show_finding");
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
