import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTtlMemo } from "./ttlMemo";

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

test("a fresh entry is served and an expired one is not", () => {
  const time = clock();
  const memo = createTtlMemo<string>({ ttlMs: 100, maxEntries: 10, now: time.now });
  memo.set("a", "alpha");
  assert.equal(memo.get("a"), "alpha");
  time.advance(99);
  assert.equal(memo.get("a"), "alpha");
  time.advance(1);
  assert.equal(memo.get("a"), undefined, "exactly at the TTL is expired");
});

test("an expired read drops the entry so the map does not hold it", () => {
  const time = clock();
  const memo = createTtlMemo<string>({ ttlMs: 10, maxEntries: 10, now: time.now });
  memo.set("a", "alpha");
  time.advance(50);
  memo.get("a");
  assert.equal(memo.size(), 0);
});

test("falsy values round-trip — a cached negative must stay cached", () => {
  const time = clock();
  const memo = createTtlMemo<boolean>({ ttlMs: 100, maxEntries: 10, now: time.now });
  memo.set("denied", false);
  assert.equal(memo.get("denied"), false);
  assert.notEqual(memo.get("denied"), undefined, "false is a hit, not a miss");
});

test("a re-set refreshes the clock", () => {
  const time = clock();
  const memo = createTtlMemo<string>({ ttlMs: 100, maxEntries: 10, now: time.now });
  memo.set("a", "alpha");
  time.advance(90);
  memo.set("a", "beta");
  time.advance(90);
  assert.equal(memo.get("a"), "beta");
});

test("the map is bounded even when every entry is still live", () => {
  const time = clock();
  const memo = createTtlMemo<number>({ ttlMs: 60_000, maxEntries: 50, now: time.now });
  for (let i = 0; i < 5_000; i += 1) memo.set(`key-${i}`, i);
  assert.ok(memo.size() <= 51, `expected a bounded map, got ${memo.size()}`);
  assert.equal(memo.get("key-4999"), 4999, "the newest insert survives the bound");
});

test("expired entries are swept before live ones are dropped", () => {
  const time = clock();
  const memo = createTtlMemo<number>({ ttlMs: 100, maxEntries: 4, now: time.now });
  for (let i = 0; i < 4; i += 1) memo.set(`old-${i}`, i);
  time.advance(200);
  memo.set("fresh", 99);
  assert.equal(memo.size(), 1, "the four expired keys went, the fresh one stayed");
  assert.equal(memo.get("fresh"), 99);
});

test("delete and clear do what they say", () => {
  const memo = createTtlMemo<string>({ ttlMs: 100, maxEntries: 10 });
  memo.set("a", "alpha");
  memo.set("b", "beta");
  memo.delete("a");
  assert.equal(memo.get("a"), undefined);
  assert.equal(memo.get("b"), "beta");
  memo.clear();
  assert.equal(memo.size(), 0);
});

test("a zero TTL caches nothing", () => {
  const memo = createTtlMemo<string>({ ttlMs: 0, maxEntries: 10 });
  memo.set("a", "alpha");
  assert.equal(memo.get("a"), undefined);
});

test("maxEntries is never below one", () => {
  const memo = createTtlMemo<number>({ ttlMs: 1_000, maxEntries: 0 });
  memo.set("a", 1);
  memo.set("b", 2);
  assert.ok(memo.size() >= 1);
  assert.ok(memo.size() <= 2);
});
