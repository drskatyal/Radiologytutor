import { expect, test } from "@playwright/test";
import { authorCaptureCase, localCaptures, localJournal, snapshot } from "../support/captureFixture";

test("T7 three silent markers become three candidates; every Jump confirms its SOP/frame and notes save retains all three", async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Synthetic mic disabled", "NotAllowedError")); });
  const { caseId } = await authorCaptureCase(page);
  await page.getByRole("button", { name: "Start recording", exact: true }).first().click();
  await expect(page.getByTestId("capture-status").getByRole("alert")).toContainText("Microphone unavailable");
  await page.keyboard.press("Alt");
  await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeVisible();
  const slider = page.getByRole("slider", { name: "Slice", exact: true }).first();
  const canvas = page.locator("[data-viewer-snapshot] canvas").first();
  const expected = [];
  for (let i = 0; i < 3; i++) {
    const previous = await snapshot(page);
    const previousIndex = Number(await slider.getAttribute("aria-valuenow") ?? await slider.inputValue());
    await slider.focus(); await slider.press(i === 0 ? "Home" : "ArrowRight");
    if (i > 0 || previousIndex > 1) await expect.poll(async () => (await snapshot(page)).sopUID).not.toBe(previous.sopUID);
    const view = await snapshot(page); expected.push(view);
    await canvas.click({ position: { x: 100, y: 100 } });
    await expect(page.getByTestId("pending-markers")).toContainText(`${i + 1} retained markers`);
  }
  expect(new Set(expected.map(s => `${s.sopUID}/${s.frame}`)).size).toBe(3);
  // A windowing drag is not a retained click marker.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + 120, { steps: 6 }); await page.mouse.up();
  await expect(page.getByTestId("pending-markers")).toContainText("3 retained markers");
  // Undo/remove are journal decisions and the keyboard shortcut must not hijack text editing.
  await canvas.click({ position: { x: 110, y: 110 } });
  await expect(page.getByTestId("pending-markers")).toContainText("4 retained markers");
  await page.keyboard.press("Alt+z");
  await expect(page.getByTestId("pending-markers")).toContainText("3 retained markers");
  await page.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect.poll(async () => (await localCaptures(page))[0]?.synced, { timeout: 20000 }).toBe(true);
  const candidates = page.getByTestId("marker-candidate");
  await expect(candidates).toHaveCount(3);
  await candidates.first().getByRole("button", { name: "Group with next" }).click();
  await expect(candidates).toHaveCount(2);
  await page.getByRole("button", { name: "Reset grouping and omissions" }).click();
  await expect(candidates).toHaveCount(3);
  await candidates.nth(1).getByRole("button", { name: "Remove proposal 2" }).click();
  await expect(candidates).toHaveCount(2);
  await expect(page.getByText(/3 retained markers · 2 draft candidates · 1 explicitly omitted/)).toBeVisible();
  await page.getByRole("button", { name: "Reset grouping and omissions" }).click();
  await expect(candidates).toHaveCount(3);
  const capture = (await localCaptures(page))[0];
  expect(capture.manifest.chunks.some(c => c.stream === "audio")).toBe(false);
  const journal = await localJournal(page, capture.manifest.sessionId);
  expect(journal.filter(e => e.kind === "marker" && e.payload?.action === "undo")).toHaveLength(1);
  for (let i = 0; i < 3; i++) {
    await candidates.nth(i).getByRole("button", { name: `Jump to candidate ${i + 1}` }).click();
    await expect(candidates.nth(i).getByRole("status")).toHaveText("Rendered and confirmed");
    const actual = await snapshot(page);
    expect(actual.sopUID).toBe(expected[i].sopUID); expect(actual.frame).toBe(expected[i].frame);
    await candidates.nth(i).getByRole("textbox", { name: /^Label/ }).fill(`Synthetic marker ${i + 1}`);
  }
  await page.screenshot({ path: test.info().outputPath("marker-candidates.png"), fullPage: true });
  await page.getByRole("button", { name: "Save 3 findings to sequence", exact: true }).click();
  await expect(candidates).toHaveCount(0);
  const response = await page.request.get(`/api/cases/${caseId}`); expect(response.status()).toBe(200);
  const saved = await response.json();
  expect(saved.findings).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    expect(saved.findings[i].sopInstanceUID).toBe(expected[i].sopUID);
    expect(saved.findings[i].frameNumber).toBe(expected[i].frame);
    expect(saved.findings[i].resolvedAnchor.calibration).toBe("PixelSpacing");
    expect(saved.findings[i].resolvedAnchor.patientPoint).not.toBeNull();
    expect(saved.findings[i].status).toBe("needs_review");
    expect(saved.findings[i].track.voice).toBe("notes");
  }
});
