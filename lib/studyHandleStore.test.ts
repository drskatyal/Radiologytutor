import { strict as assert } from "node:assert";
import { test } from "node:test";
import { regainStudyHandles, studyHandlesReadable } from "./studyHandleStore";

type Fake = FileSystemHandle & { asked: number };
function handle(query: PermissionState | "throws" | "none", request: PermissionState = "granted"): Fake {
  const h = {
    kind: "directory",
    name: "study",
    asked: 0,
    ...(query === "none"
      ? {}
      : {
          queryPermission: async () => {
            if (query === "throws") throw new Error("gone");
            return query;
          },
        }),
    requestPermission: async () => {
      h.asked += 1;
      return request;
    },
  };
  return h as unknown as Fake;
}

test("a study the browser still lets us read reopens with no prompt", async () => {
  const a = handle("granted");
  const b = handle("granted");
  assert.equal(await studyHandlesReadable([a, b]), true);
  assert.equal(a.asked + b.asked, 0, "never asks");
});

test("lapsed access, no handle, or an error: no automatic reopen (and still no prompt)", async () => {
  const lapsed = handle("prompt");
  assert.equal(await studyHandlesReadable([handle("granted"), lapsed]), false);
  assert.equal(lapsed.asked, 0, "checking never prompts");
  assert.equal(await studyHandlesReadable([]), false);
  assert.equal(await studyHandlesReadable([handle("none")]), false);
  assert.equal(await studyHandlesReadable([handle("throws")]), false);
});

test("Reopen (a click) asks the browser only where it requires a prompt", async () => {
  const ok = handle("granted");
  assert.equal((await regainStudyHandles([ok])).length, 1);
  assert.equal(ok.asked, 0);
  const lapsed = handle("prompt", "granted");
  assert.equal((await regainStudyHandles([lapsed])).length, 1);
  assert.equal(lapsed.asked, 1);
  assert.equal((await regainStudyHandles([handle("prompt", "denied")])).length, 0);
});
