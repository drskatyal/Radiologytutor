import { expect, test } from "@playwright/test";

test("exam HTML, RSC, JSON, socket frames and initial viewport contain no finding hints", async ({ page }) => {
  const captures: Promise<string>[] = [];
  const socketFrames: string[] = [];
  page.on("response", response => {
    if (response.url().startsWith("http://127.0.0.1:") && /text|json/.test(response.headers()["content-type"] ?? "")) {
      captures.push(response.text().catch(() => ""));
    }
  });
  page.on("websocket", socket => {
    socket.on("framesent", frame => socketFrames.push(String(frame.payload)));
    socket.on("framereceived", frame => socketFrames.push(String(frame.payload)));
  });
  await page.addInitScript(() => localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.goto("/case/case-synthetic-teach?mode=exam");
  await expect(page.getByTestId("exam-session")).toBeVisible();
  const slice = page.getByRole("slider", { name: "Slice" }).first();
  await expect(slice).toHaveAttribute("aria-valuetext", "Slice 3 of 4"); // findings use indices 0 and 1
  // Browser fetch preserves the localhost Secure demo session used by the page.
  const api = {
    get: (path: string) => page.evaluate(async path => { const r = await fetch(path); return { status: r.status, data: await r.json() }; }, path),
    post: (path: string, data: unknown) => page.evaluate(async ({ path, data }) => { const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }); return { status: r.status, data: await r.json() }; }, { path, data }),
  };
  const result = await api.get("/api/cases/case-synthetic-teach");
  expect(result.status).toBe(200);
  const safe = result.data;
  expect(safe.findingCount).toBe(2);
  expect(JSON.stringify(safe)).not.toMatch(/CANARY|sliceIndex|sopInstanceUID|marker|rubric|liveTeachingPack/);
  for (const suffix of ["findings", "live-teaching-pack", "prefetch"]) {
    expect((await api.get(`/api/cases/case-synthetic-teach/${suffix}`)).status).toBe(403);
  }
  for (const path of ["/api/tutor", "/api/voice/realtime", "/api/voice/search", "/api/transcribe", "/api/transcribe-narration", "/api/tour-check-in"]) {
    expect((await api.post(path, { caseId: "case-synthetic-teach" })).status).toBe(403);
  }
  const grade = await api.post("/api/grade-report", { caseId: "case-synthetic-teach", report: "My observations", mode: "practice" });
  expect(grade.status).toBe(200);
  expect(JSON.stringify(grade.data)).not.toMatch(/CANARY|rubric"|score|marker/);
  await page.goto("/case/case-synthetic-teach?mode=teach"); // mode query cannot bypass an active attempt
  await expect(page.getByTestId("exam-session")).toBeVisible();
  const html = await page.content();
  const rsc = await page.locator("script").allTextContents();
  expect([html, ...rsc, ...(await Promise.all(captures)), ...socketFrames].join("\n")).not.toContain("CANARY");
  await page.getByLabel("Your observations").fill("I see a synthetic image.");
  await page.getByRole("button", { name: "Submit and finish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Attempt completed" })).toContainText("Score: 0%");
  expect(socketFrames).toHaveLength(0); // M1 exam uses no direct provider socket
});
