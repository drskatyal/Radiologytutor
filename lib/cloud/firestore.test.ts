import { test } from "node:test";
import assert from "node:assert/strict";
import { firestoreConfig, fromFsFields, toFsFields, toFsValue } from "./firestore.ts";

test("Firestore value codec round-trips the store's shapes", () => {
  const doc = {
    id: "s1",
    count: 3,
    ratio: 0.5,
    ok: true,
    none: null,
    tags: ["chest", "ct"],
    markup: [{ seriesInstanceUID: "2.25.1", annotation: { from: [0.1, 0.2], to: [0.3, 0.4], label: "mass" } }],
  };
  assert.deepEqual(fromFsFields(toFsFields(doc)), doc);
});

test("integers travel as strings, undefined is dropped, NaN becomes null", () => {
  assert.deepEqual(toFsValue(42), { integerValue: "42" });
  assert.deepEqual(toFsFields({ a: undefined, b: 1 }), { b: { integerValue: "1" } });
  assert.deepEqual(toFsValue(Number.NaN), { nullValue: null });
});

test("config needs FIRESTORE_PROJECT and defaults the database", () => {
  assert.equal(firestoreConfig({} as NodeJS.ProcessEnv), null);
  assert.deepEqual(firestoreConfig({ FIRESTORE_PROJECT: "p" } as NodeJS.ProcessEnv), { project: "p", database: "(default)" });
});
