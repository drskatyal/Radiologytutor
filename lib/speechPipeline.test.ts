import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGuideSay, spaceGesture } from "./speechPipeline.ts";

test("nextGuideSay skips a blank line and stops at the end", () => {
  const beats = [
    { say: "Follow the stack." },
    { say: "   " },
    { say: "Lung windows." },
    { say: "" },
  ];
  assert.equal(nextGuideSay(beats, 0), "Lung windows.");
  assert.equal(nextGuideSay(beats, 2), "");
  assert.equal(nextGuideSay(beats, 8), "");
});

test("Space barges in while the attending is speaking", () => {
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: false,
      busy: false,
      speaking: true,
      recording: false,
    }),
    "barge"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: false,
      busy: false,
      speaking: false,
      recording: false,
    }),
    "push-to-talk"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: false,
      busy: false,
      speaking: false,
      recording: false,
      awaitingAnswer: true,
    }),
    "barge"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: false,
      busy: true,
      speaking: false,
      recording: false,
    }),
    "ignore"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: true,
      busy: false,
      speaking: true,
      recording: false,
    }),
    "ignore"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: true,
      typing: false,
      busy: false,
      speaking: true,
      recording: false,
    }),
    "ignore"
  );
  assert.equal(
    spaceGesture({
      code: "Space",
      repeat: false,
      typing: false,
      busy: false,
      speaking: true,
      recording: true,
    }),
    "ignore"
  );
  assert.equal(
    spaceGesture({
      code: "KeyN",
      repeat: false,
      typing: false,
      busy: false,
      speaking: true,
      recording: false,
    }),
    "ignore"
  );
});
