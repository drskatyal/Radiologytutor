import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readSketchSr } from "../lib/dicomExport/sketchDicom";

// Recording Studio teacher sketch: fake mic, draw, M marker, replay, export.
//
// Runs on the Studio's offline fallback — the bundled multi-frame MR sample
// (public/dicom/emri_small.dcm) — so it needs no archive. That sample is a
// real DICOM instance, so marks anchor to its SOP Instance UID + frame number
// and the SR export is exercised end to end. Screenshots go to
// SKETCH_SHOTS_DIR when set (no patient identifiers: the sample is
// anonymized and the Studio shows no patient module).

const shots = process.env.SKETCH_SHOTS_DIR;

test.use({
  permissions: ["microphone"],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      ...(process.env.PW_CHROMIUM_PATH ? ["--headless", "--no-sandbox"] : []),
    ],
  },
});

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

/** Put the image just below the floating nav so every draw lands on it. */
async function showStage(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="teacher-sketch-layer"]');
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - 110);
  });
}

async function stageBox(page: Page) {
  await showStage(page);
  const box = await page.getByTestId("teacher-sketch-layer").boundingBox();
  expect(box).toBeTruthy();
  return box!;
}

async function drag(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const box = await stageBox(page);
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // A slight bow so the pen path is not a straight line.
    const bow = Math.sin(t * Math.PI) * 0.02;
    await page.mouse.move(
      box.x + box.width * (from[0] + (to[0] - from[0]) * t),
      box.y + box.height * (from[1] + (to[1] - from[1]) * t + bow)
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

async function markerCenter(page: Page) {
  const box = (await page.getByTestId("teacher-marker").first().locator("span").first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("teacher sketches while recording; ink stays on its pixels through zoom, scroll and reload; SR export round-trips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  const auth = await page.request.post("/api/auth/demo", { data: { role: "author" } });
  expect(auth.ok()).toBeTruthy();
  const caseId = `e2e-sketch-${Date.now().toString(36)}`;
  const created = await page.request.post("/api/cases", {
    data: { caseId, title: "Sketch e2e", modality: "MR", pacsbinBaseUrl: "https://pacsbin.com/viewer/case/e2e" },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto(`/studio/cases/${caseId}/record`);
  await expect(page.getByTestId("sketch-palette")).toBeVisible({ timeout: 120_000 });
  const startButton = page.getByRole("button", { name: "Start recording" }).first();
  await expect(startButton).toBeEnabled({ timeout: 120_000 });
  // The projector is live once the layer knows its frame.
  await expect(page.getByTestId("teacher-sketch-layer")).toHaveAttribute("data-visible-count", "0", { timeout: 60_000 });

  // --- Record a take with the fake microphone -----------------------------
  await startButton.click();
  await expect(page.getByRole("button", { name: "Finish recording" })).toBeVisible();
  await page.waitForTimeout(400);

  await page.keyboard.press("d");
  await expect(page.getByTestId("teacher-sketch-layer")).toHaveAttribute("data-tool", "pen");
  await drag(page, [0.3, 0.35], [0.45, 0.42]);
  await page.keyboard.press("o");
  await drag(page, [0.55, 0.4], [0.68, 0.52], 8);
  await page.keyboard.press("a");
  await drag(page, [0.8, 0.75], [0.66, 0.56], 6);

  // M drops a numbered marker where the pointer is, then asks for a label.
  await page.keyboard.press("v");
  const box = await stageBox(page);
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.46);
  await page.keyboard.press("m");
  const popover = page.getByTestId("marker-label-popover");
  await expect(popover).toBeVisible();
  await popover.getByRole("textbox").fill("Enhancing lesion");
  await popover.getByRole("textbox").press("Enter");
  const marker = page.getByTestId("teacher-marker");
  await expect(marker).toHaveAttribute("data-number", "1");
  await expect(marker).toHaveAttribute("data-label", "Enhancing lesion");
  await expect(page.getByTestId("teacher-stroke")).toHaveCount(3);
  await shot(page, "studio-sketch-recording");

  // Undo / redo are ops on the same timeline.
  await page.keyboard.press("u");
  await expect(marker).toHaveAttribute("data-label", "Finding 1");
  await page.keyboard.press("Control+Shift+z");
  await expect(marker).toHaveAttribute("data-label", "Enhancing lesion");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Finish recording" }).click();
  await expect(page.getByRole("button", { name: "Replay" })).toBeEnabled({ timeout: 30_000 });

  // --- Image-space anchoring: zoom moves the mark with the anatomy ---------
  const before = await markerCenter(page);
  const host = page.locator("[data-imaging-element]").first();
  await host.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await expect.poll(async () => (await markerCenter(page)).x).not.toBeCloseTo(before.x, 0);
  await page.keyboard.press("0");
  await expect.poll(async () => Math.abs((await markerCenter(page)).x - before.x)).toBeLessThan(2);
  // Another frame of the stack: the ink is for its own image only.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("teacher-sketch-layer")).toHaveAttribute("data-visible-count", "0");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("teacher-sketch-layer")).toHaveAttribute("data-visible-count", "4");

  // --- Reload: the live sketch comes back on the same pixels --------------
  await page.reload();
  await expect(page.getByTestId("teacher-marker")).toHaveAttribute("data-label", "Enhancing lesion", { timeout: 120_000 });
  await expect.poll(async () => Math.abs((await markerCenter(page)).x - before.x)).toBeLessThan(2);

  // --- Export: DICOM SR (TID 1500), read back with dcmjs -------------------
  await page.getByRole("button", { name: "Export marks" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitemradio", { name: /DICOM SR/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = await readFile(path!);
  const { dataset, groups } = readSketchSr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(dataset.Modality).toBe("SR");
  expect(groups.map((g) => g.kind).sort()).toEqual(["arrow", "ellipse", "marker", "pen"]);
  const m = groups.find((g) => g.kind === "marker")!;
  expect(m.label).toBe("#1 Enhancing lesion");
  expect(m.sopInstanceUID).toBeTruthy();
  // The sample is multi-frame: every mark names its frame.
  expect(groups.every((g) => g.frameNumber != null && g.frameNumber >= 1)).toBe(true);

  const sidecarRes = await page.request.post(`/api/cases/${caseId}/sketch-export`, {
    data: { format: "json", items: await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]"), `flowrad:studio-sketch:${caseId}`) },
  });
  expect(sidecarRes.ok()).toBeTruthy();
  const sidecar = await sidecarRes.json();
  expect(sidecar.schema).toBe("flowrad.sketch-sidecar/1");
  expect(sidecar.items).toHaveLength(4);
});

test("replay draws the teacher's ink back in time with the take", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  expect((await page.request.post("/api/auth/demo", { data: { role: "author" } })).ok()).toBeTruthy();
  const caseId = `e2e-replay-${Date.now().toString(36)}`;
  expect(
    (
      await page.request.post("/api/cases", {
        data: { caseId, title: "Sketch replay e2e", modality: "MR", pacsbinBaseUrl: "https://pacsbin.com/viewer/case/e2e" },
      })
    ).ok()
  ).toBeTruthy();
  await page.goto(`/studio/cases/${caseId}/record`);
  const start = page.getByRole("button", { name: "Start recording" }).first();
  await expect(start).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId("teacher-sketch-layer")).toHaveAttribute("data-visible-count", "0", { timeout: 60_000 });

  await start.click();
  await expect(page.getByRole("button", { name: "Finish recording" })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.keyboard.press("d");
  await drag(page, [0.3, 0.3], [0.5, 0.4], 20);
  await page.waitForTimeout(1200);
  const box = await stageBox(page);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.press("m");
  await page.getByTestId("marker-label-popover").getByRole("textbox").press("Enter");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Finish recording" }).click();
  const replay = page.getByRole("button", { name: "Replay" });
  await expect(replay).toBeEnabled({ timeout: 30_000 });

  await replay.click();
  const layer = page.getByTestId("teacher-sketch-layer");
  // Replay starts from a blank layer, then the stroke, then the marker.
  await expect(layer).toHaveAttribute("data-visible-count", "0");
  await expect(page.getByTestId("teacher-stroke")).toHaveCount(1, { timeout: 5000 });
  await expect(page.getByTestId("teacher-marker")).toHaveCount(0);
  await shot(page, "studio-sketch-replay");
  await expect(page.getByTestId("teacher-marker")).toHaveCount(1, { timeout: 5000 });
  await expect(page.getByTestId("teacher-stroke").first()).toHaveAttribute("data-done", "true");
});
