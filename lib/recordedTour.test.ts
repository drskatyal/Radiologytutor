import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_LEAN_IN_ZOOM } from "./demoTeachingGuide.ts";
import { narrationRequestFromBody, resolveTeachingGuide } from "./teachingGuide.ts";
import {
  formatRecordedTourReport,
  loadAppliedLidcRecording,
  playRecordedGuide,
  recordedActOrder,
  recordedTourContractHeld,
  runRecordedTour,
} from "./recordedTour.ts";

test("narration request rejects a take with no audio", () => {
  const missing = narrationRequestFromBody({ durationMs: 1000 });
  assert.equal(missing.ok, false);
  const badClock = narrationRequestFromBody({
    audio: { base64: "aaaa", mime: "audio/wav" },
    durationMs: 0,
  });
  assert.equal(badClock.ok, false);
});

test("record → guide → play supersedes the LIDC demo and speaks the take", async () => {
  const report = await runRecordedTour();
  const { demo, finding, alignment } = report.applied;
  assert.equal(alignment, "estimated");
  assert.equal(finding.track?.narration?.length, 4);
  assert.ok(finding.teachingGuide);
  assert.deepEqual(recordedActOrder(finding.teachingGuide), [
    "orient",
    "search",
    "lean-in",
    "commit",
    "pearl",
  ]);
  assert.equal(finding.teachingGuide.beats.find((beat) => beat.act === "search")?.actions[0]?.type, "window");
  assert.equal(finding.teachingGuide.beats.find((beat) => beat.act === "orient")?.actions[0]?.type, "scroll");

  const demoText = (demo.teachingGuide?.beats ?? []).map((beat) => beat.say ?? "").join(" ");
  const stored = (finding.teachingGuide?.beats ?? []).map((beat) => beat.say ?? "").join(" ");
  const poisoned = resolveTeachingGuide({ ...finding, teachingGuide: demo.teachingGuide });
  const live = (poisoned?.beats ?? []).map((beat) => beat.say ?? "").join(" ");
  assert.match(demoText, new RegExp(`about ${DEMO_LEAN_IN_ZOOM.toFixed(1)} times`));
  assert.doesNotMatch(demoText, /opening pass/);
  assert.match(stored, /opening pass/);
  assert.match(stored, /vessels/);
  assert.match(stored, /2\.4 times/);
  assert.doesNotMatch(stored, /2\.2 times/);
  assert.equal(live, stored);
  assert.notEqual(live, demoText);

  const orient = poisoned?.beats.find((beat) => beat.act === "orient")?.say ?? "";
  const search = poisoned?.beats.find((beat) => beat.act === "search")?.say ?? "";
  const lean = poisoned?.beats.find((beat) => beat.act === "lean-in")?.say ?? "";
  const pearl = poisoned?.beats.find((beat) => beat.act === "pearl")?.say ?? "";
  assert.match(orient, /Follow the stack/);
  assert.match(orient, /vessels/);
  assert.doesNotMatch(orient, /carina/i);
  assert.match(search, /Lung windows/);
  assert.match(search, /grey level/);
  assert.match(lean, /2\.4 times/);
  assert.match(lean, /Come closer/);
  assert.match(pearl, /carina/i);
  assert.match(pearl, /opening pass/);
  assert.match(pearl, /narrow lung window/i);

  assert.ok(report.walked, report.play.log.join(" "));
  assert.ok(report.play.walk.length >= 3);
  assert.equal(report.play.walk.at(-1), finding.sliceIndex);
  assert.deepEqual(report.play.said, poisoned?.beats.map((beat) => beat.say));
  const lungAt = report.play.log.lastIndexOf("window:1500/-600");
  const zoomAt = report.play.log.indexOf("zoom:2.4");
  const pointAt = report.play.log.indexOf("point");
  assert.ok(lungAt > report.play.log.indexOf(`slice:${finding.sliceIndex}`));
  assert.ok(zoomAt > lungAt);
  assert.ok(pointAt > zoomAt);
  assert.equal(report.play.landedSlice, 34);

  assert.equal(report.spokenBeat, true);
  assert.equal(report.driveFirst, true);
  assert.equal(report.driver.hardPass, true);
  assert.equal(report.driver.fidelityTaught, true);
  assert.equal(report.driver.worldClass, true);
  assert.deepEqual(report.driver.holes, []);
  assert.equal(report.textOnly.hardPass, false);
  assert.equal(
    report.silent.beats[0]?.checks.find((check) => check.id === "spoken_beat")?.pass,
    false
  );
  assert.equal(recordedTourContractHeld(report), true);
  assert.match(formatRecordedTourReport(report), /CONTRACT\s+HELD/);
  assert.match(formatRecordedTourReport(report), /demo superseded\s+YES/);
});

test("a finding with no track still resolves to the stored demo guide", () => {
  const { demo } = loadAppliedLidcRecording();
  const guide = resolveTeachingGuide(demo);
  assert.equal(guide, demo.teachingGuide);
  assert.match(guide?.beats.find((beat) => beat.act === "lean-in")?.say ?? "", /2\.2 times/);
});

test("playRecordedGuide walks during search and does not speak the demo lean-in", async () => {
  const { finding } = loadAppliedLidcRecording();
  const play = await playRecordedGuide(finding);
  assert.ok(play.walk.length >= 3);
  assert.equal(play.walk[0] !== play.walk.at(-1), true);
  const said = play.said.join(" ");
  assert.match(said, /Follow the stack/);
  assert.doesNotMatch(said, /2\.2 times/);
  assert.match(said, /opening pass/);
});
