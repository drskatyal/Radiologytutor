import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { playTeachingGuide } from "./replay.ts";
import { nextGuidedIndex } from "./tourAdapt.ts";
import { authoredGuideLines, resolveTeachingGuide } from "./teachingGuide.ts";
import { getPublicCaseTemplate } from "./publicCases/catalog.ts";
import type { Finding, TeachViewerAction } from "./types.ts";
import {
  LIDC_CASE_ID,
  LIDC_STACK_SLICES,
  attachDemoTeachingGuide,
  buildLidcDemoGuide,
  buildLidcSeedCase,
  findingHasTeacherTrack,
  planPublicCaseFindings,
} from "./demoTeachingGuide.ts";

const template = getPublicCaseTemplate(LIDC_CASE_ID)!;

function noduleDraft() {
  const finding = template.findings.find((item) => /nodule/i.test(item.label));
  assert.ok(finding, "catalog nodule finding");
  return finding;
}

function action<T extends TeachViewerAction["type"]>(
  guide: ReturnType<typeof buildLidcDemoGuide>,
  act: string,
  type: T
): Extract<TeachViewerAction, { type: T }> {
  const beat = guide.beats.find((item) => item.act === act);
  const found = beat?.actions.find((item) => item.type === type);
  assert.ok(found && found.type === type, `${act} ${type}`);
  return found as Extract<TeachViewerAction, { type: T }>;
}

test("LIDC nodule demo guide is orient, search, lean-in, commit, then pearl", () => {
  const nodule = noduleDraft();
  const guide = buildLidcDemoGuide({ ...nodule, sliceIndex: 49 });
  assert.deepEqual(
    guide.beats.map((beat) => beat.act),
    ["orient", "search", "lean-in", "commit", "pearl"]
  );
  assert.ok(guide.beats.every((beat, index) => index === 0 || beat.t > guide.beats[index - 1].t));
  for (let i = 1; i < guide.beats.length; i++) {
    const gap = guide.beats[i].t - guide.beats[i - 1].t;
    assert.ok(gap <= 3_000, `baked gap ${gap}ms between ${guide.beats[i - 1].act} and ${guide.beats[i].act}`);
  }

  const scroll = action(guide, "orient", "scroll");
  assert.equal(scroll.sliceIndex, 49);
  const window = action(guide, "search", "window");
  assert.equal(window.ww, nodule.windowWidth);
  assert.equal(window.wc, nodule.windowCenter);
  const zoom = action(guide, "lean-in", "zoom");
  assert.equal(zoom.zoom, 2.2);
  const point = action(guide, "commit", "point");
  assert.equal(point.x, nodule.marker.x_pct);
  assert.equal(point.y, nodule.marker.y_pct);

  assert.match(guide.beats[0].say ?? "", /^Follow the stack\./);
  assert.match(guide.beats[1].say ?? "", /^Lung windows, 1500 over -600\./);
  assert.match(guide.beats[2].say ?? "", /^Lean in, about 2\.2 times\./);
  assert.match(guide.beats[3].say ?? "", /^Look here\./);

  const motion = guide.beats
    .filter((beat) => beat.act !== "pearl")
    .map((beat) => beat.say ?? "")
    .join(" ");
  assert.doesNotMatch(motion, /\bnodules?\b/i);

  const pearl = guide.beats[4].say ?? "";
  assert.match(pearl, /round opacities/);
  assert.match(pearl, /vessel/);
  assert.match(pearl, /solid vs subsolid/);
  assert.doesNotMatch(pearl, /\b\d+\s*mm\b/);
  assert.doesNotMatch(pearl, /lingula|right upper lobe/i);
  assert.doesNotMatch(`${motion} ${pearl}`, /\b0\.\d{2,}\b/);
});

test("every LIDC finding gets a five-beat demo guide and a teacher track wins", () => {
  const guides = template.findings.map((finding) => buildLidcDemoGuide(finding));
  for (const guide of guides) {
    assert.deepEqual(
      guide.beats.map((beat) => beat.act),
      ["orient", "search", "lean-in", "commit", "pearl"]
    );
    assert.ok(guide.beats[4].say?.includes(template.findings[guides.indexOf(guide)].description.slice(0, 24)));
    // Non-empty lines select speak() in Teach. An empty list would fall
    // through to tutorSpeechPlan and drop this script.
    assert.equal(authoredGuideLines(guide).length, guide.beats.length);
  }

  const nodule = noduleDraft();
  const recorded: Finding = {
    ...nodule,
    id: "f_teacher",
    teachingGuide: {
      durationMs: 10,
      start: { sliceIndex: 49 },
      beats: [{ t: 0, act: "pearl", actions: [], say: "Recorded by the teacher." }],
    },
    track: {
      durationMs: 800,
      start: { sliceIndex: 40, ww: 1500, wc: -600 },
      events: [{ t: 400, type: "slice", index: 49 }],
    },
  };
  assert.equal(findingHasTeacherTrack(recorded), true);
  const kept = attachDemoTeachingGuide(recorded);
  assert.equal(kept.teachingGuide?.beats[0].say, "Recorded by the teacher.");
  const rebuilt = resolveTeachingGuide(kept);
  assert.equal(rebuilt?.beats[0].actions[0]?.type, "scroll");
  assert.notEqual(rebuilt?.beats.map((beat) => beat.say).join(" "), kept.teachingGuide?.beats[0].say);
});

test("import scaling lands the demo guide on slices 34, 49, and 64", () => {
  assert.equal(LIDC_STACK_SLICES, 65);
  const planned = planPublicCaseFindings(LIDC_CASE_ID, template.findings, LIDC_STACK_SLICES);
  assert.deepEqual(
    planned.create.map((finding) => finding.sliceIndex),
    [34, 49, 64]
  );
  const nodule = planned.create.find((finding) => /nodule/i.test(finding.label));
  assert.ok(nodule?.teachingGuide);
  const scroll = nodule.teachingGuide.beats.find((beat) => beat.act === "orient")?.actions[0];
  assert.ok(scroll && scroll.type === "scroll");
  assert.equal(scroll.sliceIndex, 49);
  assert.equal(nodule.teachingGuide.beats.find((beat) => beat.act === "search")?.actions[0]?.type, "window");
  assert.ok(!planned.create.some((finding) => finding.track));

  const teacher: Finding = {
    ...nodule,
    id: "f_teacher",
    order: nodule.order,
    track: {
      durationMs: 400,
      start: { sliceIndex: 49 },
      events: [{ t: 0, type: "slice", index: 49 }],
    },
  };
  const again = planPublicCaseFindings(LIDC_CASE_ID, template.findings, LIDC_STACK_SLICES, [teacher]);
  assert.equal(again.kept.length, 1);
  assert.equal(again.kept[0].id, "f_teacher");
  assert.ok(!again.create.some((finding) => finding.order === nodule.order));

  const other = planPublicCaseFindings("case-lung-immunotherapy", template.findings, 65);
  assert.equal(other.kept.length, 0);
  assert.ok(other.create.every((finding) => finding.teachingGuide == null));
});

test("committed seed case matches the demo guide for a 65-slice stack", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../seed/case-lidc-nodule-search.json", import.meta.url), "utf8")
  ) as { caseId: string; status: string; findings: Finding[] };
  const built = buildLidcSeedCase();
  assert.equal(seed.caseId, LIDC_CASE_ID);
  assert.equal(seed.status, "published");
  assert.deepEqual(
    seed.findings.map((finding) => finding.sliceIndex),
    [34, 49, 64]
  );
  assert.deepEqual(
    seed.findings.map((finding) => finding.teachingGuide),
    built.findings.map((finding) => finding.teachingGuide)
  );
  assert.ok(seed.findings.every((finding) => !finding.track));
});

test("playTeachingGuide speaks the nodule pearl after the lean-in", async () => {
  const nodule = noduleDraft();
  const guide = buildLidcDemoGuide({ ...nodule, sliceIndex: 49 });
  const said: string[] = [];
  const applied: string[] = [];
  let slice = guide.start.sliceIndex;
  const ctrl = playTeachingGuide(
    guide,
    {
      applyEvent: (event) => {
        applied.push(event.type);
        if (event.type === "slice") slice = event.index;
      },
      getSliceIndex: () => slice,
      settle: async () => {},
      setWindow: async (ww, wc) => {
        applied.push(`window:${ww}/${wc}`);
      },
      showState: async (state) => {
        if (state.zoom != null) applied.push(`zoom:${state.zoom}`);
      },
      overlay: {
        cursor: () => applied.push("point"),
        animateTo: async () => {
          applied.push("point");
        },
      },
    },
    {
      narrate: async (text) => {
        said.push(text);
      },
      sliceStepMs: 0,
      timeScale: 0,
    }
  );
  await ctrl.finished;
  assert.deepEqual(
    said.map((line) => line.slice(0, 16)),
    [
      "Follow the stack",
      "Lung windows, 15",
      "Lean in, about 2",
      "Look here.",
      "On lung windows ",
    ]
  );
  assert.match(said[4], /nodule/);
  assert.equal(slice, 49);
  assert.ok(applied.includes("window:1500/-600"));
  assert.ok(applied.includes("zoom:2.2"));
  assert.ok(applied.includes("point"));
});

test("three LIDC guides each play orient through pearl when TTS never ends", async () => {
  const findings = buildLidcSeedCase().findings;
  assert.equal(findings.length, 3);
  const played: string[] = [];
  let index: number | null = 0;
  while (index != null) {
    const finding = findings[index];
    const guide = finding.teachingGuide;
    assert.ok(guide, finding.label);
    const said: string[] = [];
    const applied: string[] = [];
    let slice = guide.start.sliceIndex;
    const ctrl = playTeachingGuide(
      guide,
      {
        applyEvent: (event) => {
          if (event.type === "slice") slice = event.index;
        },
        getSliceIndex: () => slice,
        settle: async () => {},
        setWindow: async (ww, wc) => {
          applied.push(`window:${ww}/${wc}`);
        },
        showState: async (state) => {
          if (state.zoom != null) applied.push(`zoom:${state.zoom}`);
        },
        overlay: {
          animateTo: async (x, y) => {
            applied.push(`point:${x},${y}`);
          },
        },
      },
      {
        timeScale: 0,
        narrationHoldMs: () => 15,
        narrate: (text) => {
          said.push(text);
          return new Promise(() => {});
        },
      }
    );
    await ctrl.finished;
    assert.equal(said.length, 5, finding.label);
    assert.match(said[0] ?? "", /^Follow the stack/);
    assert.match(said[1] ?? "", /windows/i);
    assert.match(said[2] ?? "", /^Lean in/);
    assert.equal(said[3], "Look here.");
    assert.ok((said[4] ?? "").length > 40, finding.label);
    assert.equal(slice, finding.sliceIndex, finding.label);
    assert.ok(
      applied.includes(`window:${finding.windowWidth}/${finding.windowCenter}`),
      finding.label
    );
    assert.ok(applied.indexOf("zoom:1") < applied.indexOf("zoom:2.2"), finding.label);
    const marker = finding.marker;
    assert.ok(marker, finding.label);
    assert.ok(applied.includes(`point:${marker.x_pct},${marker.y_pct}`), finding.label);
    played.push(finding.label);
    index = nextGuidedIndex(index, findings.length);
  }
  assert.deepEqual(played, [
    "Lung window — start mid-chest",
    "Peripheral nodule survey",
    "Mediastinal window pass",
  ]);
});
