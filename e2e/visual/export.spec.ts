import { expect, test, type Download, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseDicom } from "dicom-parser";

// Export on the free viewer, as on FlowRad Viewer (desktop Ctrl+E): the
// current image, the whole series as a ZIP of images, the series as video
// (MP4 where the browser has an H.264 encoder, else Motion-JPEG AVI), and an
// anonymised DICOM copy as a ZIP. File names carry no patient details, and
// the reader is put back on the slice they were reading. Synthetic CT only.

const DIR = process.env.TEST_CT_DIR;
test.skip(!DIR, "TEST_CT_DIR is not set (scripts/make-test-ct.py)");

const files = () => fs.readdirSync(DIR!).map((f) => path.join(DIR!, f));
const image = (page: Page) => page.locator('[role="img"][aria-label^="DICOM viewer"]').first();
const slider = (page: Page) => page.getByRole("slider", { name: "Slice" }).first();
const NAME = /^CT(_se\d+)?_\d{8}-\d{6}/;

async function exportAs(page: Page, kind: string, timeout = 60_000): Promise<Download> {
  const dialog = page.getByRole("dialog", { name: "Export" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "Export images, video or DICOM" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${kind}`) }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    dialog.getByRole("button", { name: "Export", exact: true }).click(),
  ]);
  await expect(dialog).toBeHidden({ timeout });
  return download;
}

const bytesOf = async (d: Download) => fs.readFileSync((await d.path())!);

test("export: image, image series, video and anonymised DICOM, named without patient details", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => window.localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/viewer");
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files());
  await expect(slider(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  const count = Number(await slider(page).getAttribute("aria-valuemax"));
  expect(count).toBeGreaterThan(2);

  // Ctrl+E opens it (as on the desktop); Esc closes.
  await image(page).focus();
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Nothing is uploaded");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Image: a PNG of the view.
  const still = await exportAs(page, "Image$");
  expect(still.suggestedFilename()).toMatch(new RegExp(`${NAME.source}\\.png$`));
  const png = await bytesOf(still);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.length).toBeGreaterThan(5_000);

  // Image series: every image, in stack order, one ZIP; back on the same slice.
  const start = Number(await slider(page).getAttribute("aria-valuenow"));
  await image(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const before = String(start + 2);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", before);
  const series = await exportAs(page, "Image series");
  expect(series.suggestedFilename()).toMatch(new RegExp(`${NAME.source}_images\\.zip$`));
  const zip = new AdmZip(await bytesOf(series));
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toHaveLength(count);
  expect(names[0]).toMatch(/_0001\.png$/);
  expect([...names].sort()).toEqual(names);
  const frames = names.map((n) => zip.readFile(n)!);
  expect(frames.every((f) => f.subarray(1, 4).toString() === "PNG")).toBe(true);
  expect(new Set(frames.map((f) => f.toString("base64"))).size).toBeGreaterThan(1);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", before);

  // Video: MP4 (H.264) or, without an encoder, Motion-JPEG AVI.
  await page.getByRole("button", { name: "Export images, video or DICOM" }).click();
  await dialog.getByRole("radio", { name: /^Video/ }).click();
  await expect(dialog.getByTestId("export-video-format")).not.toHaveText("Checking video encoders…");
  const video = await exportAs(page, "Video", 120_000);
  const clip = await bytesOf(video);
  if (video.suggestedFilename().endsWith(".mp4")) {
    expect(clip.subarray(4, 8).toString()).toBe("ftyp");
  } else {
    expect(video.suggestedFilename()).toMatch(new RegExp(`${NAME.source}\\.avi$`));
    expect(clip.subarray(0, 4).toString()).toBe("RIFF");
    expect(clip.subarray(8, 12).toString()).toBe("AVI ");
  }
  expect(clip.length).toBeGreaterThan(10_000);
  await expect(slider(page)).toHaveAttribute("aria-valuenow", before);

  // DICOM (anonymised): one ZIP, renamed files, identity removed, UIDs remapped.
  const dicom = await exportAs(page, "DICOM");
  expect(dicom.suggestedFilename()).toMatch(new RegExp(`${NAME.source}_anonymised_dicom\\.zip$`));
  const copy = new AdmZip(await bytesOf(dicom));
  const entries = copy.getEntries().map((e) => e.entryName);
  expect(entries).toHaveLength(files().length);
  expect(entries.every((n) => /^DICOM\/SE001\/IM\d{5}\.dcm$/.test(n))).toBe(true);
  const first = parseDicom(new Uint8Array(copy.readFile(entries[0])!));
  expect(first.string("x00100010") ?? "").not.toContain("TEST");
  expect(first.string("x00100020") ?? "").not.toContain("CI-0001");
  expect(first.string("x0020000d")).toMatch(/^2\.25\.\d+$/);
  expect(first.string("x00120062")).toBe("YES");

  // Also on the right-click menu.
  await image(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Export/ }).hover();
  await expect(page.getByRole("menuitemradio", { name: /^Series as video/ })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /^Export images, video or DICOM/ }).press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  expect(errors).toEqual([]);
});
