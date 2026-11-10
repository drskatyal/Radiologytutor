import { request, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One demo sign-in for the whole archive suite (playwright.archive.config.ts):
// the route allows 10 per 5 minutes, and pixel reads need a session. Tests
// that must be signed out open their own clean context.
export const ARCHIVE_STORAGE_STATE = path.join(os.tmpdir(), "flowrad-e2e-archive-auth.json");

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!;
  const api = await request.newContext({ baseURL });
  const res = await api.post("/api/auth/demo", { data: {} });
  if (!res.ok()) throw new Error(`demo sign-in failed: ${res.status()} ${await res.text()}`);
  fs.mkdirSync(path.dirname(ARCHIVE_STORAGE_STATE), { recursive: true });
  await api.storageState({ path: ARCHIVE_STORAGE_STATE });
  await api.dispose();
}
