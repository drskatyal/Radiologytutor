import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The viewer core must stay forkable: no app, auth, case or teaching imports.
const ROOT = path.join(__dirname, "..", "packages", "viewer-core", "src");
const ALLOWED = [/^\.\.?\//, /^@cornerstonejs\//, /^dicom-parser$/];

test("@flowrad/viewer-core imports only itself and imaging libraries", () => {
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 19, "the core has its modules");
  for (const file of files) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    for (const m of src.matchAll(/\bfrom\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g)) {
      const spec = m[1] ?? m[2];
      assert.ok(ALLOWED.some((re) => re.test(spec)), `${file} imports "${spec}"`);
      assert.ok(!spec.startsWith("../"), `${file} reaches outside the package: "${spec}"`);
    }
    assert.doesNotMatch(src, /\bRadLearn\b|radlearn/, `${file} mentions RadLearn; keep product names in the apps`);
  }
});

test("the old lib paths still re-export the core", async () => {
  const viaLib = await import("./mpr");
  const viaCore = await import("../packages/viewer-core/src/mpr");
  assert.deepEqual(Object.keys(viaLib).sort(), Object.keys(viaCore).sort());
  const core = await import("../packages/viewer-core/src/index");
  assert.ok(Object.keys(core).length > 40, "the package entry exports the modules");
});
