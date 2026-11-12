import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { CaptureManifest, JournalEntry, ViewerSnapshot } from "../../lib/journal/types";

let syntheticAuthorCookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | undefined;

export async function authorCaptureCase(page: Page, waitForViewer = true) {
  await page.addInitScript(() => localStorage.setItem("radlearn-cookie-ack", "1"));
  await page.context().clearCookies();
  await page.goto("/viewer/local");
  if (syntheticAuthorCookies) await page.context().addCookies(syntheticAuthorCookies);
  else {
    const data = { name: "Synthetic Capture Author", email: `capture-${Date.now()}@example.test`, password: "synthetic-local-test-password" };
    let signup = await page.request.post("/api/auth/sign-up/email", { data });
    for (let attempt = 0; signup.status() === 429 && attempt < 2; attempt++) {
      // Respect the existing auth rate limit shared with the preceding suite's signups.
      const seconds = Number(signup.headers()["retry-after"] || 10);
      await page.waitForTimeout(Math.min(30000, Math.max(1000, seconds * 1000)));
      signup = await page.request.post("/api/auth/sign-up/email", { data });
    }
    expect(signup.status()).toBe(200);
    // Synthetic localhost session only, kept in memory; no credential file is read or written.
    syntheticAuthorCookies = await page.context().cookies();
  }
  const caseId = `case-capture-${Date.now()}`;
  const created = await page.request.post("/api/cases", { data: { caseId, title: "Synthetic capture test", modality: "CT", pacsbinBaseUrl: "https://pacsbin.com/viewer/case/synthetic" } });
  expect(created.status()).toBe(200);
  const data = await created.json();
  await promisify(execFile)(process.execPath, ["--import", "tsx", "e2e/support/captureFixtureSetup.ts", data.orgId, caseId], { cwd: process.cwd(), env: { ...process.env, MONGODB_URI: "", DATA_DIR: path.join(process.cwd(), ".radlearn-tmp", "radlearn-data") } });
  page.on("pageerror", error => console.log("Synthetic capture page error:", error.message));
  await page.goto(`/studio/cases/${caseId}/record`);
  if (!waitForViewer) return { caseId, orgId: data.orgId as string };
  try { await expect(page.locator("[data-viewer-snapshot]").first()).toBeVisible(); }
  catch (error) { console.log("Synthetic capture surface:", (await page.locator("body").innerText()).slice(-5000)); throw error; }
  await expect(page.getByRole("button", { name: "Start recording", exact: true }).first()).toBeEnabled();
  return { caseId, orgId: data.orgId as string };
}
export async function snapshot(page: Page): Promise<ViewerSnapshot> {
  return JSON.parse((await page.locator("[data-viewer-snapshot]").first().getAttribute("data-viewer-snapshot"))!);
}
export async function localCaptures(page: Page): Promise<{ manifest: CaptureManifest; closed: boolean; synced: boolean }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("flowrad-viewer-local");
    open.onerror = () => reject(new Error("IDB unavailable"));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("captures")) { db.close(); resolve([]); return; }
      const req = db.transaction("captures").objectStore("captures").getAll();
      req.onsuccess = () => { resolve(req.result); db.close(); };
    };
  }));
}
export async function localJournal(page: Page, sessionId: string): Promise<JournalEntry[]> {
  return page.evaluate(async id => {
    const rows = await new Promise<{ sessionId: string; chunk: { seq: number; stream: string }; blob: Blob }[]>((resolve, reject) => {
      const open = indexedDB.open("flowrad-viewer-local"); open.onerror = () => reject(new Error("IDB unavailable"));
      open.onsuccess = () => { const db = open.result; const req = db.transaction("captureChunks").objectStore("captureChunks").getAll(); req.onsuccess = () => { resolve(req.result); db.close(); }; };
    });
    const entries = [];
    for (const row of rows.filter(r => r.sessionId === id && r.chunk.stream === "journal").sort((a, b) => a.chunk.seq - b.chunk.seq)) entries.push(...JSON.parse(await row.blob.text()));
    return entries;
  }, sessionId);
}
