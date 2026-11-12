import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { authorCaptureCase, snapshot } from "./captureFixture";
import type { CaseReview } from "../../lib/review/model";
export async function authorReviewCase(page: Page, surface: "record" | "editor" = "editor") {
  const { caseId, orgId } = await authorCaptureCase(page);
  const view = await snapshot(page);
  await promisify(execFile)(process.execPath, ["--import", "tsx", "e2e/support/reviewFixtureSetup.ts", orgId, caseId, JSON.stringify(view)], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: "", DICOMWEB_BACKEND: "orthanc", ORTHANC_URL: `http://127.0.0.1:${process.env.MOCK_ARCHIVE_PORT ?? 3199}`, DATA_DIR: path.join(process.cwd(), ".radlearn-tmp", "radlearn-data") } });
  await page.goto(`/studio/cases/${caseId}${surface === "record" ? "/record" : ""}`);
  await expect(page.getByTestId("finding-review-review-1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh review", exact: true })).toBeEnabled();
  await expect(page.getByTestId("finding-review-review-1").getByRole("button", { name: "Jump", exact: true })).toBeEnabled();
  const response = await page.request.get(`/api/cases/${caseId}/review`); expect(response.status()).toBe(200);
  return { caseId, orgId, review: await response.json() as CaseReview };
}
