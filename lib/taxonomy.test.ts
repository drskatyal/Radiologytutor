import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  PATIENT_SEXES,
  TARGET_LEVELS,
} from "./types.ts";
import {
  difficultyLabel,
  difficultyBadgeVariant,
  SYSTEM_CAPTION,
} from "./taxonomy.ts";

test("ships exactly the three difficulty tiers in order", () => {
  assert.deepEqual(DIFFICULTIES, ["beginner", "intermediate", "advanced"]);
});

test("ships the canonical body-system taxonomy", () => {
  assert.deepEqual(BODY_SYSTEMS, [
    "Neuro",
    "MSK",
    "Chest",
    "Cardiac",
    "Abdominal",
    "GU",
    "Head & Neck",
    "Paediatric",
    "Vascular",
  ]);
});

test("difficultyLabel sentence-cases each tier", () => {
  assert.equal(difficultyLabel("beginner"), "Beginner");
  assert.equal(difficultyLabel("intermediate"), "Intermediate");
  assert.equal(difficultyLabel("advanced"), "Advanced");
});

test("difficultyBadgeVariant maps tier -> semantic colour", () => {
  assert.equal(difficultyBadgeVariant("beginner"), "success");
  assert.equal(difficultyBadgeVariant("intermediate"), "warning");
  assert.equal(difficultyBadgeVariant("advanced"), "danger");
});

test("every body system has a caption", () => {
  for (const s of BODY_SYSTEMS) {
    assert.equal(typeof SYSTEM_CAPTION[s], "string");
    assert.ok(SYSTEM_CAPTION[s].length > 0);
  }
});

test("ships the canonical patient-sex values", () => {
  assert.deepEqual(PATIENT_SEXES, ["M", "F", "other", "unknown"]);
});

test("ships the canonical target-level tiers in teaching order", () => {
  assert.deepEqual(TARGET_LEVELS, ["R1", "R2", "R3", "registrar", "fellow", "CME"]);
});
