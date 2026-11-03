import { test } from "node:test";
import assert from "node:assert/strict";
import { preloadable } from "./lazyView";

const Stub = () => null;

test("preload fetches a view's chunk once, however often it is asked", async () => {
  let loads = 0;
  const View = preloadable(async () => {
    loads += 1;
    return Stub;
  });
  const [a, b] = await Promise.all([View.preload(), View.preload()]);
  await View.preload();
  assert.equal(loads, 1);
  assert.equal(a, Stub);
  assert.equal(b, Stub);
});

test("a failed preload is retried by the next ask", async () => {
  let loads = 0;
  const View = preloadable(async () => {
    loads += 1;
    if (loads === 1) throw new Error("chunk fetch failed");
    return Stub;
  });
  await assert.rejects(View.preload());
  assert.equal(await View.preload(), Stub);
  assert.equal(loads, 2);
});
