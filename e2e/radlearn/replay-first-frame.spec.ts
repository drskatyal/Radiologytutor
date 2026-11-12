import { expect, test } from "@playwright/test";
import { authorCaptureCase, snapshot } from "../support/captureFixture";

test("M4 first frame keeps its SOP when archive opening offset differs from the completed stack order", async ({ page }) => {
  let openingSop = "";
  let originalOrder: string[] = [];
  let fullOrder: string[] = [];
  await page.route("**/api/dicomweb/**/metadata", async route => {
    const path = new URL(route.request().url()).pathname;
    const instance = /\/instances\/([^/]+)\/metadata$/.exec(path);
    if (instance && !openingSop) openingSop = instance[1];
    if (!/\/series\/[^/]+\/metadata$/.test(path)) return route.continue();
    const response = await route.fetch();
    const rows = await response.json();
    originalOrder = rows.map((row: Record<string, { Value: string[] }>) => row["00080018"].Value[0]);
    rows.reverse(); fullOrder = [...originalOrder].reverse();
    return route.fulfill({ response, json: rows });
  });
  await authorCaptureCase(page);
  expect(openingSop).not.toBe("");
  expect(originalOrder.indexOf(openingSop)).not.toBe(fullOrder.indexOf(openingSop));
  const shown = await snapshot(page);
  expect(shown.sopUID).toBe(openingSop); expect(shown.frame).toBe(1);
  const slider = page.getByRole("slider", { name: "Slice", exact: true }).first();
  const value = Number(await slider.getAttribute("aria-valuenow") ?? await slider.inputValue());
  expect(value).toBe(fullOrder.indexOf(openingSop) + 1);
});

test("M4/T3 completed stack missing the opening SOP fails closed instead of retaining its archive index", async ({ page }) => {
  let openingSop = "";
  await page.route("**/api/dicomweb/**/metadata", async route => {
    const path = new URL(route.request().url()).pathname;
    const instance = /\/instances\/([^/]+)\/metadata$/.exec(path);
    if (instance && !openingSop) openingSop = instance[1];
    if (!/\/series\/[^/]+\/metadata$/.test(path)) return route.continue();
    const response = await route.fetch();
    const rows = await response.json();
    return route.fulfill({ response, json: rows.filter((row: Record<string, { Value: string[] }>) => row["00080018"].Value[0] !== openingSop) });
  });
  await authorCaptureCase(page, false);
  await expect(page.getByText("This series could not be displayed.", { exact: true })).toBeVisible();
  expect(openingSop).not.toBe("");
  await expect(page.getByRole("button", { name: "Start recording", exact: true }).first()).toBeDisabled();
  await expect(page.locator("[data-viewer-snapshot]")).toHaveCount(0);
});
