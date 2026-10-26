import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCloudRunMongo } from "./durableStore.ts";

test("dev and tests keep the JSON fallback when K_SERVICE is unset", () => {
  assert.doesNotThrow(() => assertCloudRunMongo({} as NodeJS.ProcessEnv));
  assert.doesNotThrow(() =>
    assertCloudRunMongo({ MONGODB_URI: "" } as NodeJS.ProcessEnv)
  );
});

test("Cloud Run without MONGODB_URI refuses JSON-on-disk", () => {
  assert.throws(
    () => assertCloudRunMongo({ K_SERVICE: "radlearn" } as NodeJS.ProcessEnv),
    /MONGODB_URI/
  );
  assert.throws(
    () =>
      assertCloudRunMongo({
        K_SERVICE: "radlearn",
        MONGODB_URI: "   ",
      } as NodeJS.ProcessEnv),
    /JSON-on-disk/
  );
});

test("Cloud Run with MONGODB_URI is allowed", () => {
  assert.doesNotThrow(() =>
    assertCloudRunMongo({
      K_SERVICE: "radlearn",
      MONGODB_URI: "mongodb+srv://user:pass@radlearn.example.mongodb.net/radlearn",
    } as NodeJS.ProcessEnv)
  );
});
