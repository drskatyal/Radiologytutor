import { expect, test } from "@playwright/test";
import { authorCaptureCase, localCaptures, localJournal } from "../support/captureFixture";

test("T4 crash recovery retains acknowledged journal/media and sends missing chunks only", async ({ page, context }) => {
  test.setTimeout(120000);
  const { caseId } = await authorCaptureCase(page);
  const receipts: { seq: number; sha256: string; stream: string }[] = [];
  let block = false;
  await page.route("**/capture-sessions/*/chunks/*", async route => {
    if (block && route.request().method() === "PUT") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic offline interval" }) });
    return route.continue();
  });
  page.on("response", async response => {
    if (response.request().method() === "PUT" && response.url().includes("/capture-sessions/") && response.status() === 200) receipts.push(await response.json());
  });
  await page.getByRole("button", { name: "Start recording", exact: true }).first().click();
  await expect.poll(() => receipts.filter(r => r.stream === "audio").length, { timeout: 20000 }).toBeGreaterThan(0);
  block = true;
  const retainedBefore = (await localCaptures(page))[0];
  const id = retainedBefore.manifest.sessionId;
  const oldJournal = await localJournal(page, id);
  const canvas = page.locator("[data-viewer-snapshot] canvas").first();
  await canvas.click({ position: { x: 100, y: 100 } });
  await expect.poll(async () => (await localCaptures(page))[0].manifest.chunks.length).toBeGreaterThan(receipts.length);
  const acknowledged = [...receipts];
  await page.close(); // destroys the recording clock, without a stop or completion request
  const restored = await context.newPage();
  await restored.goto(`/studio/cases/${caseId}/record`);
  await expect(restored.getByRole("button", { name: "Recover recording", exact: true })).toBeVisible();
  const resent: number[] = [];
  restored.on("request", request => { if (request.method() === "PUT" && request.url().includes("/capture-sessions/")) resent.push(Number(request.url().split("/").at(-1))); });
  await restored.getByRole("button", { name: "Recover recording", exact: true }).click();
  await expect.poll(async () => (await localCaptures(restored))[0].synced, { timeout: 20000 }).toBe(true);
  const response = await restored.request.get(`/api/cases/${caseId}/capture-sessions/${id}/manifest`);
  expect(response.status()).toBe(200); const manifest = await response.json();
  expect(manifest.status).toBe("complete");
  for (const ack of acknowledged) {
    expect(manifest.chunks.find((c: { seq: number }) => c.seq === ack.seq).sha256).toBe(ack.sha256);
    expect(resent).not.toContain(ack.seq);
  }
  const journal = await localJournal(restored, id);
  expect(journal.slice(0, oldJournal.length)).toEqual(oldJournal);
  expect(journal.at(-1)?.payload?.reason).toBe("page_interrupted");
  expect(journal.some(e => e.kind === "marker" && e.snapshot?.sopUID && e.payload?.imagePoint)).toBe(true);
  await expect(restored.getByRole("button", { name: "Restore captured view" })).toBeVisible();
});

test("capture routes require a session; PUT receipts are idempotent and conflicting bytes return 409", async ({ page, browser }) => {
  const { caseId } = await authorCaptureCase(page);
  const id = "synthetic-route-contract";
  const base = `/api/cases/${caseId}/capture-sessions/${id}`;
  const anonymous = await browser.newContext({ baseURL: "http://127.0.0.1:3102" });
  expect((await anonymous.request.get(`${base}/manifest`)).status()).toBe(401);
  expect((await anonymous.request.put(`${base}/chunks/0`, { data: "synthetic" })).status()).toBe(401);
  await anonymous.close();
  expect((await page.request.post(`${base}/manifest`, { data: { action: "start" } })).status()).toBe(200);
  const body = "synthetic-only-video";
  const { createHash } = await import("node:crypto");
  const meta = { seq: 0, stream: "video", tStart: 100, tEnd: 200, mime: "video/webm", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
  const send = (bytes: string, metadata: typeof meta) => page.request.put(`${base}/chunks/0`, { headers: { "X-Capture-Chunk": JSON.stringify(metadata) }, data: bytes });
  const first = await send(body, meta), again = await send(body, meta);
  expect(first.status()).toBe(200); expect(again.status()).toBe(200); expect(await again.json()).toEqual(await first.json());
  const changed = `${body}!`;
  expect((await send(changed, { ...meta, bytes: Buffer.byteLength(changed), sha256: createHash("sha256").update(changed).digest("hex") })).status()).toBe(409);
  expect((await page.request.post("/api/gemini/files", { data: { caseId, sessionId: id } })).status()).toBe(409);
  expect((await page.request.post("/api/structure-finding", { data: { capture: { caseId, sessionId: id }, audioBase64: "c3ludGhldGlj" } })).status()).toBe(409);
  expect((await page.request.post("/api/structure-session", { data: { caseId, track: { captureSessionId: id }, audioBase64: "c3ludGhldGlj" } })).status()).toBe(409);
});
