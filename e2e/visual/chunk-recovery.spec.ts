import { expect, test, type Page, type Route } from "@playwright/test";

// A lazy chunk disappears under an open /viewer tab: what a deploy does to a
// tab that loaded the previous build (and what a dropped request looks like).
// The chunk removed is Cornerstone tools, the one from the production report
// ("Loading chunk 2785 failed"); the engine cannot start without it.
//
//   • transient: the first two fetches fail, the import retries and the study
//     opens without a reload;
//   • deleted, then the "deploy" finishes: the tab shows "Updating viewer,
//     reloading…", reloads once, says the viewer was updated, and the study
//     opens again on the same series;
//   • deleted for good: one reload only, then a calm "could not load" with a
//     Reload button. Never a raw "Loading chunk" on the stage.

const CT_DIR = process.env.TEST_CT_DIR;

/** The tools chunk, recognised by content (chunk ids change between builds). */
function isToolsChunk(body: string): boolean {
  return body.includes("StackScrollTool") && body.includes("cornerstoneTools") && /^\(self\.webpackChunk/.test(body);
}

interface ChunkGate {
  /** Fetches of the tools chunk the page made. */
  requests: number;
  /** Whether the tools chunk was seen at all (guards the test's own premise). */
  matched: boolean;
}

/**
 * Route every lazy chunk; fail the tools chunk while `fail(n)` says so
 * (n = 1-based fetch count of that chunk).
 */
async function gateToolsChunk(page: Page, fail: (n: number) => "ok" | "404" | "abort"): Promise<ChunkGate> {
  const gate: ChunkGate = { requests: 0, matched: false };
  const known = new Map<string, boolean>();
  await page.route(/\/_next\/static\/chunks\/[^/]+\.js$/, async (route: Route) => {
    const url = route.request().url();
    let tools = known.get(url);
    if (tools === undefined) {
      const res = await route.fetch();
      tools = isToolsChunk(await res.text());
      known.set(url, tools);
      if (!tools) return route.fulfill({ response: res });
    }
    if (!tools) return route.continue();
    gate.matched = true;
    gate.requests += 1;
    const verdict = fail(gate.requests);
    if (verdict === "abort") return route.abort("failed");
    if (verdict === "404") {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found", headers: { "cache-control": "no-store" } });
    }
    return route.continue();
  });
  return gate;
}

async function drop(page: Page) {
  await page.locator("input[type=file][webkitdirectory]").setInputFiles(CT_DIR!);
}

async function firstImageDrawn(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const received = performance.getEntriesByName("flowrad:viewer:files-received").pop()?.startTime ?? 0;
          return performance.getEntriesByType("mark").some((m) => m.name.startsWith("radlearn:first-rendered:") && m.startTime >= received);
        }),
      { timeout: 30_000 }
    )
    .toBe(true);
}

/** No raw chunk error reached the screen at any point. */
function watchForRawErrors(page: Page): () => string[] {
  const seen: string[] = [];
  const check = async () => {
    try {
      const text = await page.locator("body").innerText({ timeout: 1000 });
      const hit = text.match(/.*(Loading chunk|ChunkLoadError|Error: ).*/);
      if (hit) seen.push(hit[0]);
    } catch {
      /* navigating */
    }
  };
  const timer = setInterval(check, 100);
  return () => {
    clearInterval(timer);
    return seen;
  };
}

test.beforeEach(() => {
  test.skip(!CT_DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");
});

test("chunk recovery: a chunk that fails twice is retried and the study opens without a reload", async ({ page }) => {
  const gate = await gateToolsChunk(page, (n) => (n <= 2 ? "abort" : "ok"));
  let navigations = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1;
  });
  const stop = watchForRawErrors(page);
  await page.goto("/viewer");
  await drop(page);
  await firstImageDrawn(page);
  expect(gate.matched, "the tools chunk was identified").toBe(true);
  expect(gate.requests).toBeGreaterThanOrEqual(3);
  expect(navigations, "no reload").toBe(1);
  expect(stop()).toEqual([]);
});

test("chunk recovery: deleted mid-session, the tab reloads once onto the new build and reopens the study", async ({ page }) => {
  // Missing until the reload (the old build's chunk is gone), then served (the
  // live build has it).
  // Real document loads (not Next's history.replaceState at hydration).
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
  });
  const gate = await gateToolsChunk(page, () => (documents >= 2 ? "ok" : "404"));
  const stop = watchForRawErrors(page);
  await page.goto("/viewer");
  await drop(page);
  await expect(page.getByText("Updating viewer, reloading…")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => documents, { timeout: 20_000 }).toBe(2);
  // Back on the live build: told what happened, files never left the computer.
  await expect(page.getByText("The viewer was updated")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/stayed on this computer/)).toBeVisible();
  await drop(page);
  await firstImageDrawn(page);
  expect(gate.matched).toBe(true);
  expect(stop()).toEqual([]);
});

test("chunk recovery: a chunk that stays missing reloads once, then offers Reload instead of looping", async ({ page }) => {
  const gate = await gateToolsChunk(page, () => "404");
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  const stop = watchForRawErrors(page);
  await page.goto("/viewer");
  await drop(page);
  await expect(page.getByText("Updating viewer, reloading…")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => loads, { timeout: 20_000 }).toBe(2);
  await drop(page);
  const recovery = page.getByTestId("viewer-recovery");
  await expect(recovery).toBeVisible({ timeout: 20_000 });
  await expect(recovery.getByText("The viewer could not load")).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Reload page" })).toBeEnabled();
  // Give a loop the chance to happen: it must not.
  await page.waitForTimeout(1500);
  expect(loads, "exactly one automatic reload").toBe(2);
  expect(gate.matched).toBe(true);
  expect(stop()).toEqual([]);
});
