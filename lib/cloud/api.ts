// Shared helpers for the account API routes (server only).

import { HttpError, ensureAccount, requireUser } from "./auth";
import { viewerStore } from "./store";
import type { Account, Collection, Study } from "./types";
import type { SessionUser } from "./session";

export async function requireAccount(): Promise<{ user: SessionUser; account: Account }> {
  const user = requireUser();
  return { user, account: await ensureAccount(user) };
}

/** The study, if the user owns it; otherwise 404 (never 403: do not confirm it exists). */
export async function ownedStudy(id: string, userId: string): Promise<Study> {
  const study = /^[\w-]{6,64}$/.test(id) ? await viewerStore().getStudy(id) : null;
  if (!study || study.ownerId !== userId) throw new HttpError(404, "Study not found.");
  return study;
}

export async function ownedCollection(id: string, userId: string): Promise<Collection> {
  const c = /^[\w-]{6,64}$/.test(id) ? await viewerStore().getCollection(id) : null;
  if (!c || c.ownerId !== userId) throw new HttpError(404, "Collection not found.");
  return c;
}

export async function readJson(req: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}
